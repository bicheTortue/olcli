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

// Dynamically import the client
const { getClient } = await import('./client.js');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

let pendingImportRef = '';
let pendingPushRef = '';

for await (const line of rl) {
  // Uncomment to see the exact Git conversation!
  console.error(`[DEBUG] Git asked: ${line}`);
  let argv = line.split(' ');

  switch (argv[0]){
    case "capabilities" :
      console.log('import');
    //console.log('refspec HEAD:refs/heads/main');
    console.log('refspec refs/heads/*:refs/heads/*'); // <-- MUST BE EXACTLY THIS
    console.log('option');
    console.log('list');
    console.log('push');
    console.log('');
    break;
    case "option":
      runOption(argv);
    break;
    case "list":
      runList(argv);
    break;
    case "push":
      // argv[1] looks like "refs/heads/main:refs/heads/main"
      // We split by ':' and take the second half (the destination)
      pendingPushRef = argv[1].split(':')[1];
    //runPush(argv);
    break;
    case "import":
      // Git is asking for an import. Save it, but wait for the blank line!
      pendingImportRef = argv[1];
    //await runImport(pendingImportRef);
    break;

    case "":
      // Git sent the blank line ("Over"). Now it is our turn to talk!
      if (pendingImportRef !== '') {
      await runImport(pendingImportRef);
      pendingImportRef = ''; // Reset for the next conversation
    } else if (pendingPushRef !== '') {
      await runPush(pendingPushRef);  // <-- Call your new push function!
      pendingPushRef = '';
    } else {
      process.exit(0);
    }
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
async function runPush(refToUpdate:  string){//TODO Check if push is necessary
  let tempDir = '';
  try {
    const client = await getClient();

    let projInfo = await client.getProjectById(projectId);
    if (!projInfo) projInfo = await client.getProject(projectId);
    if (!projInfo) {
      console.error(`\n[olcli] Error: Could not find project '${projectId}'`);
      process.exit(1);
    }
    const overleafTime = Math.floor(new Date(projInfo.lastUpdated).getTime() / 1000);
    const localTime = getLocalCommitTime(refToUpdate);
    if (overleafTime > localTime ){ //Checking for newer version online
      console.log(`error ${refToUpdate} Remote has newer changes. Please pull first.`);
      console.log('');
      //return;
    }else{

      // Create a fast lookup dictionary: { "chapters/intro.tex" => { id: "123", type: "doc" } }
      const remoteFiles = new Map<string, { id: string, type: 'doc'|'file'|'folder' }>();

      const projectInfo = await client.getProjectInfo(projectId);
      if (projectInfo && projectInfo.rootFolder && projectInfo.rootFolder[0]) {
        function buildFileMap(folder: any, currentPath: string = '') {
          for (const doc of folder.docs || []) {
            remoteFiles.set(currentPath ? `${currentPath}/${doc.name}` : doc.name, { id: doc._id, type: 'doc' });
          }
          for (const file of folder.fileRefs || []) {
            remoteFiles.set(currentPath ? `${currentPath}/${file.name}` : file.name, { id: file._id, type: 'file' });
          }
          for (const sub of folder.folders || []) {
            const subPath = currentPath ? `${currentPath}/${sub.name}` : sub.name;
            remoteFiles.set(subPath, { id: sub._id, type: 'folder' });
            buildFileMap(sub, subPath);
          }
        }
        buildFileMap(projectInfo.rootFolder[0]);
      }

      let folderTree = await client.getFolderTreeFromSocket(projectId);
      if (!folderTree) folderTree = {};

      const remoteName = process.argv[2]; // e.g., 'origin'
      const branchName = refToUpdate.split('/').pop(); // e.g., 'main'
      const trackingRef = `refs/remotes/${remoteName}/${branchName}`;

      const commits = execSync(`git rev-list --reverse ${trackingRef}..HEAD`, { encoding: 'utf8' }).trim().split('\n');

      for (const hash of commits) {
        // 1. Get the commit message (Subject line only)
        const commitMsg = execSync(`git show -s --format=%s ${hash}`, { encoding: 'utf8' }).trim();
        //console.error(`[olcli] Pushing commit: ${commitMsg}`);

        // 2. Get files added/modified in THIS commit
        const uploadStr = execSync(`git diff-tree --no-commit-id --name-only --diff-filter=ACMR -r ${hash}`, { encoding: 'utf8' }).trim();
        const filesToUpload = uploadStr ? uploadStr.split('\n') : [];

        // 3. Get files deleted in THIS commit
        const deleteStr = execSync(`git diff-tree --no-commit-id --name-only --diff-filter=D -r ${hash}`, { encoding: 'utf8' }).trim();
        const filesToDelete = deleteStr ? deleteStr.split('\n') : [];
        //console.error(hash,filesToUpload, filesToDelete);

        // 4. Upload the files
        for (const file of filesToUpload) {
          // CRUCIAL: Get the file content exactly as it was in THIS commit!
          // Using execSync with `{ encoding: 'buffer' }` safely handles binary files like PDFs/PNGs
          if ( file !== ".gitignore") {
            try {
              const content = execSync(`git show ${hash}:"${file}"`, { encoding: 'buffer' });
              await client.uploadFile(projectId!, null, file, content, folderTree);
              //spinner.text = `Uploading... (${uploaded}/${filesToUpload.length})`;
            } catch (error: any) {
              console.log(`error ${refToUpdate} Failed to upload ${file}: ${error.message}`);
            }
          }
        }

        // 5. Delete the files
        for (const file of filesToDelete) {
          const entity = remoteFiles.get(file);
          if (!entity) {
            console.log(`error ${refToUpdate} Failed to delete ${file}: Does not exist remotely`);
          }else{
            try {
              await client.deleteEntity(projectId!, entity.id, entity.type);
            } catch (error: any) {
              console.log(`error ${refToUpdate} Failed to delete ${file}: ${error.message}`);
            }
          }
        }

        // 6. Apply the Overleaf Label!
        //await client.applyOverleafLabel(projectId, commitMsg);
      }

      console.log(`ok ${refToUpdate}`);
      //console.log(`error ${refToUpdate} Testing stuff`);
      console.log('');
    }

  } catch (error: any) {
    console.log(`error ${refToUpdate} Push failed: ${error.message}`);
    console.log('');
  }
}

async function runImport(refToUpdate:  string){
  let tempDir = '';
  try {
    const client = await getClient();

    let projInfo = await client.getProjectById(projectId);
    if (!projInfo) projInfo = await client.getProject(projectId);
    if (!projInfo) {
      console.error(`\n[olcli] Error: Could not find project '${projectId}'`);
      process.exit(1);
    }
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
      //streamData += `feature done\n`; // <-- MUST BE HERE!
      //streamData += `reset ${refToUpdate}\n`;
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


      // DEBUG: Print the header to the terminal so we can see if it's formatted perfectly!
      //console.error(`\n[DEBUG STREAM]\n${streamData}`);
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
