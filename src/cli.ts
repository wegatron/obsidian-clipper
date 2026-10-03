// Browser globals (DOMParser, window, document) are provided by the esbuild
// banner in scripts/build-cli.mjs. They must run before any bundled module code.
import { parseHTML } from 'linkedom';
import { clip, matchTemplate, DocumentParser } from './api';
import { openInObsidian } from './utils/cli-utils';
import { fetchViaBrowser, withBrowserPage } from './utils/browser-fetch';
import { localizeImages, type ImageFetcher } from './utils/image-localizer';
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
	imagesDir?: string;
	imagesStrict: boolean;
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
      --images-dir <dir>       Download content images into this directory (requires -o)
      --images-strict          Fail without writing the note if any image fails
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
	let imagesDir: string | undefined;
	let imagesStrict = false;

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
			case '--images-dir':
				if (!args[i + 1] || args[i + 1].startsWith('-')) throw new Error('--images-dir requires a value');
				imagesDir = args[++i];
				break;
			case '--images-strict':
				imagesStrict = true;
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

	if (imagesDir && !outputPath) throw new Error('--images-dir requires -o / --output');
	if (imagesDir && open) throw new Error('--images-dir cannot be combined with --open');
	if (imagesStrict && !imagesDir) throw new Error('--images-strict requires --images-dir');

	return { imagesDir, imagesStrict, url, templatePath, outputPath, vault, open, silent, uri, propertyTypesPath, htmlPath, browser, interactive, browserPath };
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

	const cancellation = new AbortController();
	const cancel = () => cancellation.abort(new Error('Clipping cancelled'));
	if (args.imagesDir) {
		process.once('SIGINT', cancel);
		process.once('SIGTERM', cancel);
	}
	const output = async (page: { html: string; url: string; baseUrl?: string; fetchImage?: ImageFetcher }) => {
		const { html, url: pageUrl, baseUrl: browserBaseUrl, fetchImage: imageFetcher } = page;
		const resourceDocument = args.imagesDir ? linkedomParser.parseFromString(html, 'text/html') : undefined;
		const baseHref = resourceDocument?.querySelector('base[href]')?.getAttribute('href');
		let resourceBaseUrl = browserBaseUrl ?? pageUrl;
		if (!browserBaseUrl && baseHref) {
			try { resourceBaseUrl = new URL(baseHref, pageUrl).href; } catch { /* Invalid base falls back to the page URL. */ }
		}
		// If using a template directory, match template by triggers.
		// Try URL triggers first (no parsing needed). Only parse for schema if required.
		let parsedDocument: any = resourceDocument;
		if (templates) {
			// First try URL-only matching (no HTML parsing needed)
			let matched = matchTemplate(templates, args.url);

			// If no URL match, check if any templates have schema triggers
			if (!matched) {
				const hasSchemaTrigs = templates.some(t => t.triggers?.some(tr => tr.startsWith('schema:')));
				if (hasSchemaTrigs) {
					const DefuddleClass = (await import('defuddle')).default;
					parsedDocument ??= linkedomParser.parseFromString(html, 'text/html');
					const defuddle = new DefuddleClass(parsedDocument as unknown as Document, { url: args.imagesDir ? resourceBaseUrl : args.url });
					const defuddleResult = defuddle.parse();
					matched = matchTemplate(templates, args.url, defuddleResult.schemaOrgData);
				}
			}

			if (!matched) {
				throw new Error(`No template matched URL ${args.url}; searched ${templates.length} templates in ${args.templatePath}`);
			}
			template = matched;
			console.error(`Matched template: ${templateFilePaths.get(template) || 'unknown'}`);
		}

		if (!template) {
			throw new Error('No template resolved');
		}

		// Call the API (reuse pre-parsed document if available)
		const result = await clip({
			html,
			url: args.url,
			template,
			documentParser: linkedomParser,
			propertyTypes,
			parsedDocument,
			resourceBaseUrl: args.imagesDir ? resourceBaseUrl : undefined,
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
			let content = result.fullContent;
			if (args.imagesDir) {
				const localized = await localizeImages({
					markdown: result.content, pageBaseUrl: resourceBaseUrl, noteFilePath: filePath,
					imagesDir: path.resolve(args.imagesDir), imageFetcher, signal: cancellation.signal,
				});
				console.error(`Images: ${localized.saved} saved, ${localized.reused} reused, ${localized.failures.length} failed, ${localized.skipped} skipped`);
				for (const failure of localized.failures) console.error(`Image failed: ${failure.url}: ${failure.error}`);
				if (args.imagesStrict && localized.failures.length) throw new Error('Image download failed in strict mode; note was not written');
				content = result.frontmatter + localized.markdown;
				cancellation.signal.throwIfAborted();
			}
			fs.writeFileSync(filePath, content, 'utf-8');
			// Full path on stdout so calling agents can pick it up.
			console.log(filePath);
		} else {
			process.stdout.write(result.fullContent);
		}
	};
	try {
		if (args.htmlPath) {
			await output({ html: fs.readFileSync(args.htmlPath === '-' ? 0 : path.resolve(args.htmlPath), 'utf-8'), url: args.url });
		} else if (args.browser && args.imagesDir) {
			await withBrowserPage(args.url, { interactive: args.interactive, browserPath: args.browserPath, signal: cancellation.signal },
				page => {
					if (process.env.CLIPPER_DEBUG_HTML) fs.writeFileSync(process.env.CLIPPER_DEBUG_HTML, page.html, 'utf-8');
					return output(page);
				});
		} else if (args.browser) {
			const html = await fetchViaBrowser(args.url, { interactive: args.interactive, browserPath: args.browserPath });
			if (process.env.CLIPPER_DEBUG_HTML) fs.writeFileSync(process.env.CLIPPER_DEBUG_HTML, html, 'utf-8');
			await output({ html, url: args.url });
		} else {
			const response = await fetch(args.url, { signal: cancellation.signal });
			if (!response.ok) throw new Error(`Failed to fetch ${args.url}: ${response.status} ${response.statusText}`);
			await output({ html: await response.text(), url: response.url });
		}
	} finally {
		process.removeListener('SIGINT', cancel);
		process.removeListener('SIGTERM', cancel);
	}
}

main().catch(err => {
	console.error(err.message || err);
	process.exit(1);
});
