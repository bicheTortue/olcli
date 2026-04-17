#!/usr/bin/env node
import * as readline from 'node:readline';
import { mkdtempSync, rmSync, statSync, createReadStream, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import AdmZip from 'adm-zip';

import { getClient } from './client.js';

const remoteName = process.argv[2];
const url = process.argv[3];

const projectId = url;//TODO Handles real urls

process.argv = [process.argv[0], process.argv[1]];


const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

// A flag to track if we are in the middle of a batch command
let isImporting = false;

// Using an async loop ensures we process one line fully before reading the next!
for await (const line of rl) {
  console.error(`[DEBUG] Git asked: ${line}`);

  if (line === 'capabilities') {
    console.log('import');
    // FIX: Tell Git exactly how our branch maps to its branch
    console.log('refspec HEAD:refs/heads/main');
    console.log('');
  }

  else if (line === 'list') {
    console.log(`? refs/heads/main`);
    console.log(`@refs/heads/main HEAD`);
    console.log('');
  }

  else if (line.startsWith('import')) {
    isImporting = true;
    let tempDir = '';
    try {
      const client = await getClient();

      console.error(`[olcli] Fetching project from Overleaf...`);
      const zipBuffer = await client.downloadProject(projectId);

      tempDir = mkdtempSync(join(tmpdir(), 'overleaf-sync-'));
      const zipPath = join(tempDir, 'project.zip');
      const extractDir = join(tempDir, 'extracted');

      writeFileSync(zipPath, zipBuffer);
      const zip = new AdmZip(zipPath);
      zip.extractAllTo(extractDir, true);

      function getFilesToImport(dir: string, fileList: string[] = []) {
        const items = readdirSync(dir, { withFileTypes: true });
        for (const item of items) {
          const fullPath = join(dir, item.name);
          if (item.isDirectory()) {
            getFilesToImport(fullPath, fileList);
          } else {
            fileList.push(fullPath);
          }
        }
        return fileList;
      }

      const files = getFilesToImport(extractDir);

      const timestamp = Math.floor(Date.now() / 1000);
      const commitMsg = "Sync from Overleaf\n";

      process.stdout.write(`commit refs/heads/main\n`);
      process.stdout.write(`committer Overleaf Sync <sync@overleaf.com> ${timestamp} +0000\n`);
      process.stdout.write(`data ${Buffer.byteLength(commitMsg, 'utf8')}\n`);
      process.stdout.write(commitMsg);

      for (const filePath of files) {
        const repoPath = relative(extractDir, filePath).replace(/\\/g, '/');
        const fileSize = statSync(filePath).size;

        process.stdout.write(`M 100644 inline "${repoPath.replace(/"/g, '\\"')}"\n`);
        process.stdout.write(`data ${fileSize}\n`);

        await new Promise<void>((resolve, reject) => {
          const stream = createReadStream(filePath);
          stream.on('data', chunk => process.stdout.write(chunk));
          stream.on('end', () => {
            process.stdout.write(`\n`);
            resolve();
          });
          stream.on('error', reject);
        });
      }

      process.stdout.write(`done\n`);
      // Note: We do NOT print a blank console.log('') here.
      // Git will send a blank line to finish the batch, and we handle it below!

    } catch (error: any) {
      console.error(`[olcli] Error fetching from Overleaf: ${error.message}`);
      process.exit(1);
    } finally {
      if (tempDir) {
        rmSync(tempDir, { recursive: true, force: true });
      }
    }
  }

  else if (line === '') {
    if (isImporting) {
      // Git sent the blank line to finish the import batch.
      // We reply with a blank line to say "Batch successfully fulfilled!"
      console.log('');
      isImporting = false;
    } else {
      // A blank line outside of a batch means Git is saying Goodbye.
      process.exit(0);
    }
  }
}
