#!/usr/bin/env node
import * as readline from 'node:readline';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import AdmZip from 'adm-zip';
import { execSync } from 'node:child_process';

// Hide the arguments so Commander doesn't panic
const url = process.argv[3];
//TODO add url support
const projectId = url;
process.argv = [process.argv[0], process.argv[1]];

// Dynamically import the client
const { getClient } = await import('./client.js');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

for await (const line of rl) {
  // Uncomment to see the exact Git conversation!
  console.error(`[DEBUG] Git asked: ${line}`);
  let argv = line.split(' ');

  switch (argv[0]){
    case "capabilities" :
      console.log('import');
    console.log('refspec HEAD:refs/heads/main');
    console.log('option');
    console.log('list');
    console.log('push');
    //console.log('fetch');
    console.log('');
    break;
    case "option":
      runOption(argv);
    break;
    case "list":
      runList(argv);
    break;
    case "push":
      runPush(argv);
    break;
    case "fetch":
      runFetch(argv);
    break;
    case "import":
      await runImport(argv);
    break;
    case "":
      process.exit(0);
    break;
  }
}

function runOption(argv:  string[]): void {
  //console.log("TODO: " + argv)
  console.log("unsupported")
}
function runList(argv:  string[]): void {
  // The '?' tells Git to trust the fast-import stream to create the hash
  console.log(`? refs/heads/main`);
  console.log(`@refs/heads/main HEAD`);
  console.log('');
}
function runPush(argv:  string[]): void {
  console.log("TODO: " + argv)
}
function runFetch(argv:  string[]): void {
  console.log("TODO: " + argv)
}
async function runImport(argv:  string[]){
  let tempDir = '';
  try {
    const client = await getClient();

    let projInfo = await client.getProjectById(projectId);
    if (!projInfo) projInfo = await client.getProject(projectId);
    if (!projInfo) {
      console.error(`\n[olcli] Error: Could not find project '${projectId}'`);
      process.exit(1);
    }
    const refToUpdate = argv[1] || 'refs/heads/main';
    const overleafTime = Math.floor(new Date(projInfo.lastUpdated).getTime() / 1000);
    const localTime = getLocalCommitTime(refToUpdate);
    const hasLocalHistory = localTime > 0;

    if (overleafTime === localTime) {
      console.error(`[olcli] Project '${projInfo.name}' already up to date...`);

      const localHash = getLocalCommitHash(refToUpdate);

      // Tell fast-import to just point the branch to the existing commit!
      process.stdout.write(`feature done\n`);
      process.stdout.write(`reset ${refToUpdate}\n`);
      process.stdout.write(`from ${localHash}\n`);
      process.stdout.write(`done\n`, () => {
        console.log(''); // Finish the batch
      });
    }else{
      console.error(`[olcli] Fetching project '${projInfo.name}'...`);
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
      //const timestamp = Math.floor(Date.now() / 1000);
      const timestamp = Math.floor(new Date(projInfo.lastUpdated).getTime() / 1000);
      const commitMsg = "Sync from Overleaf\n";

      // --- START FAST-IMPORT STREAM ---

      // FIX 1: Dynamically use the exact ref Git requested!

      let streamData = '';
      // FIX 2: Explicitly reset the branch to accept our new commit
      streamData += `reset ${refToUpdate}\n`;
      streamData += `commit ${refToUpdate}\n`;
      // FIX 3: Add the mandatory mark and author fields
      streamData += `mark :1\n`;
      streamData += `author Overleaf Sync <sync@overleaf.com> ${timestamp} +0000\n`;
      streamData += `committer Overleaf Sync <sync@overleaf.com> ${timestamp} +0000\n`;
      streamData += `data ${Buffer.byteLength(commitMsg, 'utf8')}\n`;
      streamData += commitMsg;

      if (hasLocalHistory) {
        streamData += `from ${refToUpdate}^0\n`;
      }

      process.stdout.write(streamData);

      for (const filePath of files) {
        let repoPath = relative(extractDir, filePath).replace(/\\/g, '/');

        // FIX 4: Strip any accidental leading slashes or dots that crash fast-import
        repoPath = repoPath.replace(/^\/+/, '').replace(/^\.\//, '');

          const formattedPath = repoPath.includes(' ') ? `"${repoPath}"` : repoPath;
        const content = readFileSync(filePath);

        process.stdout.write(`M 100644 inline ${formattedPath}\n`);
        process.stdout.write(`data ${content.length}\n`);
        process.stdout.write(content);
        process.stdout.write(`\n`);
      }

      // FIX 5: Use a callback to guarantee Node.js flushes the pipe
      // before we tell Git the batch is done. This prevents race conditions!
      process.stdout.write(`done\n`, () => {
        console.log(''); // Tell Git the batch is complete!
      });

      // --- END FAST-IMPORT STREAM ---
    }

  } catch (error: any) {
    console.error(`\n[olcli] Error fetching from Overleaf: ${error.message}`);
    process.exit(1);
  } finally {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

function getLocalCommitTime(ref: string): number {
  try {
    // If successful, returns the timestamp
    const out = execSync(`git log -1 --format=%ct ${ref}`, { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' });
    return parseInt(out.trim(), 10);
  } catch {
    // If it fails (e.g. fresh clone), return 0
    return 0;
  }
}
function getLocalCommitHash(ref: string): string {
  try {
    return execSync(`git rev-parse ${ref}`, { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}
