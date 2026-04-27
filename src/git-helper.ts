#!/usr/bin/env node
import * as readline from 'node:readline';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import AdmZip from 'adm-zip';
import { execSync } from 'node:child_process';
import { OverleafClient } from './client.js';

const { getClient } = await import('./client.js');


async function main() {

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
  });

  let pendingImportRef = '';
  let pendingPushRef = '';

  const parser = new GitProtocol(process.argv[3], process.argv[2]);

  for await (const line of rl) {
    console.error(`[DEBUG] Git asked: ${line}`);
    let argv = line.split(' ');

    switch (argv[0]){
      case "capabilities" :
        console.log('import');
      //console.error(process.argv);
      console.log('refspec refs/heads/*:refs/heads/*');
      //console.log(`refspec refs/heads/*:refs/remotes/${process.argv[2]}/*`);
      console.log('option');
      console.log('list');
      console.log('push');
      console.log('');
      break;
      case "option":
        parser.runOption(argv);
      break;
      case "list":
        parser.runList(argv);
      break;
      case "push":
        pendingPushRef = argv[1].split(':')[1];
      break;
      case "import":
        pendingImportRef = argv[1];
      break;

      case "":
        if (pendingImportRef !== '') {
        await parser.runImport(pendingImportRef);
        pendingImportRef = '';
      } else if (pendingPushRef !== '') {
        await parser.runPush(pendingPushRef);
        pendingPushRef = '';
      } else {
        process.exit(0);
      }
      break;
    }
  }
}


class GitProtocol {
  private remote: string;
  private trackingRef: string;//const trackingRef = `refs/remotes/${remoteName}/${branchName}`;
  private baseUrl: string;
  private projectId: string;
  private client?: OverleafClient;

  constructor(url: string, remote: string){
    this.remote = remote;
    const urlT = url.split('/');
    this.projectId = urlT[urlT.length -1];
    this.baseUrl = urlT[0]+"//"+urlT[2];
    this.trackingRef = `refs/remotes/${remote}/main`;

  }

  /*
   * Method handling the option request from git-remote-helper
   */
  public runOption(argv:  string[]): void {//TODO: Actually handle options
    console.log("unsupported");
  }
  /*
   * Method handling the list request from git-remote-helper
   */
  public runList(argv:  string[]): void {
    const isPushing = argv.includes('for-push');

    if (isPushing) {
      try {
        const hash = this.getLocalCommitHash(this.trackingRef);
        console.log(`${hash} refs/heads/main`);
      } catch {
        console.log(`? refs/heads/main`);
      }
    } else {
      console.log(`? refs/heads/main`);
    }

    console.log(`@refs/heads/main HEAD`);
    console.log('');
  }

  /*
   * Method handling the push request from git-remote-helper
   */
  public async runPush(refToUpdate:  string){

    let commitsStr = '';
    try {
      commitsStr = execSync(`git rev-list --reverse ${this.trackingRef}..${refToUpdate}`, { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }).trim();
    } catch (e) {
      commitsStr = execSync(`git rev-list --reverse ${refToUpdate}`, { encoding: 'utf8' }).trim();
    }

    if (!commitsStr) {
      console.log(`ok ${refToUpdate}`);
      console.log('');
      return;
    }
    const commits = commitsStr.split('\n');

    let tempDir = '';
    try {
      if(!this.client) this.client = await getClient();

      let project = await this.client.getProjectById(this.projectId);
      if (!project) {
        console.log(`error ${refToUpdate} Could not find project : ${this.projectId}`);
        return;
      }

      const overleafTime = Math.floor(new Date(project.lastUpdated).getTime() / 1000);
      const localTime = this.getLocalCommitTime(refToUpdate);

      if (overleafTime > localTime ){
        console.log(`error ${refToUpdate} Remote has newer changes. Please pull first.`);
        console.log('');
        return;
      }else{

        const remoteFiles = new Map<string, { id: string, type: 'doc'|'file'|'folder' }>();
        const projectInfo = await this.client.getProjectInfo(this.projectId);

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

        let folderTree = await this.client.getFolderTreeFromSocket(this.projectId);
        if (!folderTree) folderTree = {};

        for (const hash of commits) {
          const commitMsg = execSync(`git show -s --format=%s ${hash}`, { encoding: 'utf8' }).trim();

          const uploadStr = execSync(`git diff-tree --no-commit-id --name-only --diff-filter=ACMR -r ${hash}`, { encoding: 'utf8' }).trim();
          const filesToUpload = uploadStr ? uploadStr.split('\n') : [];

          const deleteStr = execSync(`git diff-tree --no-commit-id --name-only --diff-filter=D -r ${hash}`, { encoding: 'utf8' }).trim();
          const filesToDelete = deleteStr ? deleteStr.split('\n') : [];

          for (const file of filesToUpload) {
            if ( file !== ".gitignore") {
              try {
                const content = execSync(`git show ${hash}:"${file}"`, { encoding: 'buffer' });
                await this.client.uploadFile(this.projectId!, null, file, content, folderTree);
              } catch (error: any) {
                console.log(`error ${refToUpdate} Failed to upload ${file}: ${error.message}`);
              }
            }
          }

          for (const file of filesToDelete) {
            const entity = remoteFiles.get(file);
            if (!entity) {
              console.log(`error ${refToUpdate} Failed to delete ${file}: Does not exist remotely`);
            }else{
              try {
                await this.client.deleteEntity(this.projectId!, entity.id, entity.type);
              } catch (error: any) {
                console.log(`error ${refToUpdate} Failed to delete ${file}: ${error.message}`);
              }
            }
          }
          if(filesToDelete.length > 0) {
            const folderEntries = Array.from(remoteFiles.entries())
            .filter(([path, entity]) => entity.type === 'folder');

            folderEntries.sort(([pathA], [pathB]) => pathB.split('/').length - pathA.split('/').length);

            for (const [folderPath, entity] of folderEntries) {
              const folderPrefix = folderPath + '/';

              // Check if ANY key left in the map starts with this folder's path
              if (! Array.from(remoteFiles.keys()).some(
                key => key.startsWith(folderPrefix)
              )) {

                try {
                  await this.client.deleteEntity(this.projectId, entity.id, 'folder');
                  remoteFiles.delete(folderPath);
                } catch (e) {
                  console.log(`error ${refToUpdate} Failed to delete folder ${folderPath}`);
                }
              }
            }
          }

          /*
             try {

             const project = await this.client.getProjectInfo(this.projectId);

          //console.error(project.version);
          await this.client.applyOverleafLabel(this.projectId, commitMsg, project.version || 0);

          } catch (err: any) {
          console.error(`  -> Warning: Failed to apply label '${commitMsg}'`);
          }
          */
        }

        console.log(`ok ${refToUpdate}`);
        console.log('');
      }

    } catch (error: any) {
      console.log(`error ${refToUpdate} Push failed: ${error.message}`);
      console.log('');
    }
  }
  /*
   * Method handling the import request from git-remote-helper
   */
  public async runImport(refToUpdate:  string){
    let tempDir = '';
    try {
      if(!this.client) this.client = await getClient();

      //this.branch = refToUpdate.split('/').pop() || 'main';
      //const trackingRef = `refs/remotes/${process.argv[2]}/${branchName}`;

      let project = await this.client.getProjectById(this.projectId);
      if (!project) {
        console.error(`\n[olcli] Error: Could not find project '${this.projectId}'`);
        process.exit(1);
      }
      const overleafTime = Math.floor(new Date(project.lastUpdated).getTime() / 1000);
      const localTime = this.getLocalCommitTime(this.trackingRef);
      const hasLocalHistory = localTime > 0;

      console.error(overleafTime, localTime);

      //Checking if pulling is necessary
      if (overleafTime === localTime) {

        const localHash = this.getLocalCommitHash(this.trackingRef);

        process.stdout.write(`feature done\n`);
        process.stdout.write(`reset ${refToUpdate}\n`);
        process.stdout.write(`from ${localHash}\n`);
        process.stdout.write(`done\n`, () => {
          console.log('');
        });

      }else{
        //Downloading the zip file
        const zipBuffer = await this.client.downloadProject(this.projectId);

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
        const timestamp = overleafTime;
        const commitMsg = "Sync from Overleaf\n";

        let streamData = '';
        //streamData += `feature done\n`;
        streamData += `commit ${refToUpdate}\n`;
        streamData += `mark :1\n`;
        streamData += `author Overleaf Sync <sync@overleaf.com> ${timestamp} +0000\n`;
        streamData += `committer Overleaf Sync <sync@overleaf.com> ${timestamp} +0000\n`;
        streamData += `data ${Buffer.byteLength(commitMsg, 'utf8')}\n`;
        streamData += commitMsg;

        const parentHash = this.getLocalCommitHash(this.trackingRef);
        if (parentHash) {
          console.error(parentHash);
          streamData += `from ${parentHash}\n`;
        }


        process.stdout.write(streamData);

        for (const filePath of files) {
          let repoPath = relative(extractDir, filePath).replace(/\\/g, '/');

          repoPath = repoPath.replace(/^\/+/, '').replace(/^\.\//, '');

            const formattedPath = repoPath.includes(' ') ? `"${repoPath}"` : repoPath;
          const content = readFileSync(filePath);

          process.stdout.write(`M 100644 inline ${formattedPath}\n`);
          process.stdout.write(`data ${content.length}\n`);
          process.stdout.write(content);
          process.stdout.write(`\n`);
        }

        process.stdout.write(`done\n`, () => {
          console.log('');
        });
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

  private getLocalCommitHash(ref: string): string {
    try {
      return execSync(`git rev-parse ${ref}`, { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }).trim();
    } catch {
      return '';
    }
  }

  private getLocalCommitTime(ref: string): number {
    try {
      return parseInt(execSync(`git log -1 --format=%ct ${ref}`, { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }).trim(), 10);
    } catch {
      return 0;
    }
  }

}

main();
