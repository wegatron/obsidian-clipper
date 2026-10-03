import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

const root = path.resolve(__dirname, '..');
let outputDir: string;

beforeAll(() => {
	execFileSync(process.execPath, [path.join(root, 'scripts/build-cli.mjs')], { cwd: root, stdio: 'pipe' });
	outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipper-cli-test-'));
});

afterAll(() => {
	if (outputDir) fs.rmSync(outputDir, { recursive: true, force: true });
});

function runCli(outputPath: string): string {
	return execFileSync(process.execPath, [
		path.join(root, 'dist/cli.cjs'),
		'https://example.com/article',
		'--html', path.join(root, 'src/utils/fixtures/templates/minimal.html'),
		'-o', outputPath,
	], { encoding: 'utf-8' }).trim();
}

describe('CLI output', () => {
	test('creates a nonexistent dotted directory when the path ends with a separator', () => {
		const directory = path.join(outputDir, 'notes.v1');
		const filePath = runCli(directory + path.sep);
		expect(fs.statSync(directory).isDirectory()).toBe(true);
		expect(filePath).toBe(path.join(directory, 'Minimal Page.md'));
		expect(fs.readFileSync(filePath, 'utf-8')).toContain('title: "Minimal Page"');
	});

	test('writes an explicit markdown file and prints its absolute path', () => {
		const filePath = path.join(outputDir, 'article.md');
		expect(runCli(filePath)).toBe(filePath);
		expect(fs.statSync(filePath).isFile()).toBe(true);
	});
});
