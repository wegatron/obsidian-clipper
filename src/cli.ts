// Browser globals (DOMParser, window, document) are provided by the esbuild
// banner in scripts/build-cli.mjs. They must run before any bundled module code.
import { parseHTML } from 'linkedom';
import { clip, matchTemplate, DocumentParser } from './api';
import { openInObsidian } from './utils/cli-utils';
import { fetchViaBrowser } from './utils/browser-fetch';
import { sanitizeFileName } from './utils/string-utils';
import { Template } from './types/types';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

interface CliArgs {
	url: string;
	templatePath?: string;
	outputPath?: string;
	vault?: string;
	open: boolean;
	silent: boolean;
	uri: boolean;
	propertyTypesPath?: string;
	htmlPath?: string;
	browser: boolean;
	interactive: boolean;
	browserPath?: string;
}

// Default template used when --template is omitted (AI-agent mode).
const DEFAULT_TEMPLATE: Template = {
	id: 'cli-default',
	name: 'Default',
	behavior: 'create',
	noteNameFormat: '{{title}}',
	path: '',
	noteContentFormat: '{{content}}',
	properties: [
		{ name: 'title', value: '{{title}}' },
		{ name: 'source', value: '{{url}}' },
		{ name: 'author', value: '{{author}}' },
		{ name: 'published', value: '{{published}}' },
		{ name: 'created', value: '{{date}}' },
	],
};

function printUsage(): void {
	const usage = `
Usage: obsidian-clipper <url> [options]

Options:
  -t, --template <path>        Path to template JSON file or directory
                               If a directory, auto-matches template by URL triggers
                               (optional: a built-in default template is used when omitted)
  -o, --output <path>          Output path. If it's a directory, the file is named
                               after the page title and the full path is printed to stdout.
                               Default: stdout
      --html <path>            Read HTML from file instead of fetching URL (use - for stdin)
      --browser                Fetch the page via a real browser (persistent profile,
                               keeps login cookies; renders JS-heavy pages)
      --interactive            Like --browser, but the browser stays open until you
                               close it — use to log in to a site the first time
      --browser-path <path>    Custom browser executable (default: Chrome, then Edge)
      --vault <name>           Obsidian vault name
      --open                   Send to Obsidian instead of writing file
      --uri                    Use URI scheme instead of Obsidian CLI
      --silent                 Suppress Obsidian focus (URI mode)
      --property-types <path>  JSON mapping property names to types
  -h, --help                   Show this help message
`.trim();
	console.log(usage);
}

function parseArgs(argv: string[]): CliArgs {
	const args = argv.slice(2);
	let url = '';
	let templatePath: string | undefined;
	let outputPath: string | undefined;
	let vault: string | undefined;
	let open = false;
	let silent = false;
	let uri = false;
	let propertyTypesPath: string | undefined;
	let htmlPath: string | undefined;
	let browser = false;
	let interactive = false;
	let browserPath: string | undefined;

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		switch (arg) {
			case '-h':
			case '--help':
				printUsage();
				process.exit(0);
				break;
			case '-t':
			case '--template':
				if (i + 1 >= args.length) { console.error('Error: --template requires a value'); process.exit(1); }
				templatePath = args[++i];
				break;
			case '-o':
			case '--output':
				if (i + 1 >= args.length) { console.error('Error: --output requires a value'); process.exit(1); }
				outputPath = args[++i];
				break;
			case '--vault':
				if (i + 1 >= args.length) { console.error('Error: --vault requires a value'); process.exit(1); }
				vault = args[++i];
				break;
			case '--open':
				open = true;
				break;
			case '--silent':
				silent = true;
				break;
			case '--uri':
				uri = true;
				break;
			case '--html':
				if (i + 1 >= args.length) { console.error('Error: --html requires a value'); process.exit(1); }
				htmlPath = args[++i];
				break;
			case '--browser':
				browser = true;
				break;
			case '--interactive':
				interactive = true;
				browser = true;
				break;
			case '--browser-path':
				if (i + 1 >= args.length) { console.error('Error: --browser-path requires a value'); process.exit(1); }
				browserPath = args[++i];
				break;
			case '--property-types':
				if (i + 1 >= args.length) { console.error('Error: --property-types requires a value'); process.exit(1); }
				propertyTypesPath = args[++i];
				break;
			default:
				if (!arg.startsWith('-') && !url) {
					url = arg;
				} else {
					console.error(`Unknown option: ${arg}`);
					printUsage();
					process.exit(1);
				}
		}
	}

	if (!url) {
		console.error('Error: URL is required');
		printUsage();
		process.exit(1);
	}

	return { url, templatePath, outputPath, vault, open, silent, uri, propertyTypesPath, htmlPath, browser, interactive, browserPath };
}

// ---------------------------------------------------------------------------
// Template loading
// ---------------------------------------------------------------------------

const templateFilePaths = new Map<Template, string>();

function loadTemplatesFromDir(dirPath: string): Template[] {
	const resolved = path.resolve(dirPath);
	const files = fs.readdirSync(resolved).filter(f => f.endsWith('.json'));
	return files.map(f => {
		const raw = fs.readFileSync(path.join(resolved, f), 'utf-8');
		const template: Template = JSON.parse(raw);
		templateFilePaths.set(template, path.join(resolved, f));
		return template;
	});
}

// ---------------------------------------------------------------------------
// linkedom-based DocumentParser for the API
// ---------------------------------------------------------------------------

const linkedomParser: DocumentParser = {
	parseFromString(html: string, _mimeType: string) {
		return parseHTML(html).document;
	}
};

// ---------------------------------------------------------------------------
// Output path resolution (supports writing into a directory)
// ---------------------------------------------------------------------------

/**
 * Resolve -o: an existing directory (or a trailing-separator / extensionless
 * path) means "write into it, named after the note"; anything else is a file.
 * Returns the absolute file path.
 */
function resolveOutputPath(outputPath: string, noteName: string, url: string): string {
	const resolved = path.resolve(outputPath);
	let isDir: boolean;
	if (fs.existsSync(resolved)) {
		isDir = fs.statSync(resolved).isDirectory();
	} else {
		isDir = !path.extname(resolved) || outputPath.endsWith(path.sep) || outputPath.endsWith('/');
	}

	if (!isDir) return resolved;

	fs.mkdirSync(resolved, { recursive: true });
	// clip() already sanitizes noteName; fall back to the host when untitled.
	const name = noteName && noteName !== 'Untitled'
		? noteName
		: sanitizeFileName(new URL(url).hostname);
	return path.join(resolved, `${name}.md`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	const args = parseArgs(process.argv);

	// Determine if template path is a file or directory (omitted -> built-in default)
	let templates: Template[] | undefined;
	let template: Template | undefined;

	if (args.templatePath) {
		const resolvedTemplatePath = path.resolve(args.templatePath);
		const isDir = fs.statSync(resolvedTemplatePath).isDirectory();
		if (isDir) {
			templates = loadTemplatesFromDir(resolvedTemplatePath);
			if (templates.length === 0) {
				console.error(`Error: No .json template files found in ${args.templatePath}`);
				process.exit(1);
			}
		} else {
			const templateRaw = fs.readFileSync(resolvedTemplatePath, 'utf-8');
			template = JSON.parse(templateRaw);
		}
	} else {
		template = DEFAULT_TEMPLATE;
	}

	// Load optional property types
	let propertyTypes: Record<string, string> | undefined;
	if (args.propertyTypesPath) {
		const raw = fs.readFileSync(path.resolve(args.propertyTypesPath), 'utf-8');
		propertyTypes = JSON.parse(raw);
	}

	// Get HTML: from file/stdin (--html), via real browser (--browser), or by fetching URL
	let html: string;
	if (args.htmlPath) {
		if (args.htmlPath === '-') {
			html = fs.readFileSync(0, 'utf-8'); // stdin
		} else {
			html = fs.readFileSync(path.resolve(args.htmlPath), 'utf-8');
		}
	} else if (args.browser) {
		html = await fetchViaBrowser(args.url, {
			interactive: args.interactive,
			browserPath: args.browserPath,
		});
		// ponytail: debug-only env dump for diagnosing bad captures
		if (process.env.CLIPPER_DEBUG_HTML) {
			fs.writeFileSync(process.env.CLIPPER_DEBUG_HTML, html, 'utf-8');
		}
	} else {
		const response = await fetch(args.url);
		if (!response.ok) {
			console.error(`Failed to fetch ${args.url}: ${response.status} ${response.statusText}`);
			process.exit(1);
		}
		html = await response.text();
	}

	// If using a template directory, match template by triggers.
	// Try URL triggers first (no parsing needed). Only parse for schema if required.
	let parsedDocument: any;
	if (templates) {
		// First try URL-only matching (no HTML parsing needed)
		let matched = matchTemplate(templates, args.url);

		// If no URL match, check if any templates have schema triggers
		if (!matched) {
			const hasSchemaTrigs = templates.some(t => t.triggers?.some(tr => tr.startsWith('schema:')));
			if (hasSchemaTrigs) {
				const DefuddleClass = (await import('defuddle')).default;
				parsedDocument = linkedomParser.parseFromString(html, 'text/html');
				const defuddle = new DefuddleClass(parsedDocument as unknown as Document, { url: args.url });
				const defuddleResult = defuddle.parse();
				matched = matchTemplate(templates, args.url, defuddleResult.schemaOrgData);
			}
		}

		if (!matched) {
			console.error(`Error: No template matched URL ${args.url}`);
			console.error(`Searched ${templates.length} templates in ${args.templatePath}`);
			process.exit(1);
		}
		template = matched;
		console.error(`Matched template: ${templateFilePaths.get(template) || 'unknown'}`);
	}

	if (!template) {
		console.error('Error: No template resolved');
		process.exit(1);
	}

	// Call the API (reuse pre-parsed document if available)
	const result = await clip({
		html,
		url: args.url,
		template,
		documentParser: linkedomParser,
		propertyTypes,
		parsedDocument,
	});

	// Output
	if (args.open) {
		const vault = args.vault || template.vault || '';
		const obsResult = await openInObsidian(
			result.fullContent,
			result.noteName,
			template.path || '',
			vault,
			template.behavior || 'create',
			args.silent,
			args.uri
		);
		console.error(obsResult);
	} else if (args.outputPath) {
		const filePath = resolveOutputPath(args.outputPath, result.noteName, args.url);
		fs.writeFileSync(filePath, result.fullContent, 'utf-8');
		// Full path on stdout so calling agents can pick it up.
		console.log(filePath);
	} else {
		process.stdout.write(result.fullContent);
	}
}

main().catch(err => {
	console.error(err.message || err);
	process.exit(1);
});
