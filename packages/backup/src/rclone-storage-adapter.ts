import {
    StorageAdapter,
    FileContents,
    StatEntry,
    WriteOptions,
    CopyFileOptions,
    MoveFileOptions,
    CreateDirectoryOptions,
    PublicUrlOptions,
    TemporaryUrlOptions,
    ChecksumOptions,
    MimeTypeOptions,
    MiscellaneousOptions,
} from '@flystorage/file-storage';
import { Readable, PassThrough } from 'stream';
import { spawn, execFile } from 'child_process';
import { promisify } from 'util';
import { BackupDestination } from './backup-destination.js';

const execFileAsync = promisify(execFile);

export class RcloneStorageAdapter implements StorageAdapter {
    private readonly remoteName = 'flystorage_backup_remote';

    constructor(
        private readonly destination: BackupDestination,
        private readonly rcloneBinary: string = 'rclone',
    ) {}

    private getEnv(): Record<string, string> {
        const env: Record<string, string> = {};
        for (const [key, val] of Object.entries(process.env)) {
            if (val !== undefined) {
                env[key] = val;
            }
        }
        const prefix = `RCLONE_CONFIG_${this.remoteName.toUpperCase()}_`;

        switch (this.destination.type) {
            case 'local':
                env[`${prefix}TYPE`] = 'local';
                break;
            case 'ftp':
                env[`${prefix}TYPE`] = 'ftp';
                env[`${prefix}HOST`] = this.destination.host;
                env[`${prefix}PORT`] = String(this.destination.port ?? 21);
                env[`${prefix}USER`] = this.destination.username;
                if (this.destination.password) {
                    env[`${prefix}PASS`] = this.destination.password;
                }
                break;
            case 'sftp':
                env[`${prefix}TYPE`] = 'sftp';
                env[`${prefix}HOST`] = this.destination.host;
                env[`${prefix}PORT`] = String(this.destination.port ?? 22);
                env[`${prefix}USER`] = this.destination.username;
                if (this.destination.password) {
                    env[`${prefix}PASS`] = this.destination.password;
                }
                if (this.destination.privateKey) {
                    env[`${prefix}KEY_PEM`] = this.destination.privateKey;
                }
                break;
            case 'google-drive':
                env[`${prefix}TYPE`] = 'drive';
                env[`${prefix}CLIENT_ID`] = this.destination.clientId;
                env[`${prefix}CLIENT_SECRET`] = this.destination.clientSecret;
                env[`${prefix}REFRESH_TOKEN`] = this.destination.refreshToken;
                if (this.destination.folderId) {
                    env[`${prefix}ROOT_FOLDER_ID`] = this.destination.folderId;
                }
                break;
            case 'onedrive':
                env[`${prefix}TYPE`] = 'onedrive';
                env[`${prefix}CLIENT_ID`] = this.destination.clientId;
                env[`${prefix}CLIENT_SECRET`] = this.destination.clientSecret;
                env[`${prefix}REFRESH_TOKEN`] = this.destination.refreshToken;
                break;
        }
        return env;
    }

    private getRemotePath(path: string): string {
        if (this.destination.type === 'local') {
            return `${this.destination.rootDirectory}/${path}`;
        }
        return `${this.remoteName}:${path}`;
    }

    private async runRclone(args: string[]): Promise<string> {
        const { stdout } = await execFileAsync(this.rcloneBinary, args, { env: this.getEnv() });
        return stdout;
    }

    async write(path: string, contents: Readable, options: WriteOptions): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            const child = spawn(
                this.rcloneBinary,
                ['rcat', this.getRemotePath(path)],
                { env: this.getEnv(), stdio: ['pipe', 'ignore', 'pipe'] }
            );

            contents.pipe(child.stdin);

            let stderr = '';
            child.stderr?.on('data', chunk => {
                stderr += chunk.toString();
            });

            child.on('close', code => {
                if (code === 0) {
                    resolve();
                } else {
                    reject(new Error(`rclone write failed with code ${code}: ${stderr}`));
                }
            });

            child.on('error', reject);
        });
    }

    async read(path: string, options: MiscellaneousOptions): Promise<FileContents> {
        const child = spawn(
            this.rcloneBinary,
            ['cat', this.getRemotePath(path)],
            { env: this.getEnv(), stdio: ['ignore', 'pipe', 'pipe'] }
        );

        const outStream = new PassThrough();
        child.stdout.pipe(outStream);

        child.on('error', err => {
            outStream.emit('error', err);
        });

        child.stderr?.on('data', data => {
            const msg = data.toString();
            if (msg.includes('directory not found') || msg.includes('file not found')) {
                outStream.emit('error', new Error(`File not found: ${path}`));
            }
        });

        return outStream;
    }

    async deleteFile(path: string, options: MiscellaneousOptions): Promise<void> {
        await this.runRclone(['deletefile', this.getRemotePath(path)]);
    }

    async createDirectory(path: string, options: CreateDirectoryOptions): Promise<void> {
        await this.runRclone(['mkdir', this.getRemotePath(path)]);
    }

    async copyFile(from: string, to: string, options: CopyFileOptions): Promise<void> {
        await this.runRclone(['copyto', this.getRemotePath(from), this.getRemotePath(to)]);
    }

    async moveFile(from: string, to: string, options: MoveFileOptions): Promise<void> {
        await this.runRclone(['moveto', this.getRemotePath(from), this.getRemotePath(to)]);
    }

    async stat(path: string, options: MiscellaneousOptions): Promise<StatEntry> {
        try {
            const out = await this.runRclone(['lsjson', '--stat', this.getRemotePath(path)]);
            const item = JSON.parse(out);
            if (item.IsDir) {
                return {
                    path,
                    type: 'directory',
                    isFile: false,
                    isDirectory: true,
                    lastModifiedMs: item.ModTime ? new Date(item.ModTime).getTime() : undefined,
                };
            } else {
                return {
                    path,
                    type: 'file',
                    isFile: true,
                    isDirectory: false,
                    size: item.Size,
                    lastModifiedMs: item.ModTime ? new Date(item.ModTime).getTime() : undefined,
                };
            }
        } catch (e) {
            // Fallback for older rclone or if stat fails
            const dir = path.includes('/') ? path.substring(0, path.lastIndexOf('/')) : '';
            const file = path.includes('/') ? path.substring(path.lastIndexOf('/') + 1) : path;
            const out = await this.runRclone(['lsjson', this.getRemotePath(dir)]);
            const items = JSON.parse(out);
            const found = items.find((i: any) => i.Name === file);
            if (!found) {
                throw new Error(`Path ${path} not found`);
            }
            if (found.IsDir) {
                return {
                    path,
                    type: 'directory',
                    isFile: false,
                    isDirectory: true,
                    lastModifiedMs: found.ModTime ? new Date(found.ModTime).getTime() : undefined,
                };
            } else {
                return {
                    path,
                    type: 'file',
                    isFile: true,
                    isDirectory: false,
                    size: found.Size,
                    lastModifiedMs: found.ModTime ? new Date(found.ModTime).getTime() : undefined,
                };
            }
        }
    }

    async *list(path: string, options: { deep: boolean }): AsyncGenerator<StatEntry> {
        const args = ['lsjson'];
        if (options.deep) {
            args.push('--recursive');
        }
        args.push(this.getRemotePath(path));

        const out = await this.runRclone(args);
        const items = JSON.parse(out);

        for (const item of items) {
            const itemPath = path ? `${path}/${item.Path}` : item.Path;
            if (item.IsDir) {
                yield {
                    path: itemPath,
                    type: 'directory',
                    isFile: false,
                    isDirectory: true,
                    lastModifiedMs: item.ModTime ? new Date(item.ModTime).getTime() : undefined,
                };
            } else {
                yield {
                    path: itemPath,
                    type: 'file',
                    isFile: true,
                    isDirectory: false,
                    size: item.Size,
                    lastModifiedMs: item.ModTime ? new Date(item.ModTime).getTime() : undefined,
                };
            }
        }
    }

    async changeVisibility(path: string, visibility: string, options: MiscellaneousOptions): Promise<void> {
        // Rclone doesn't have a generic permission command across all backends. No-op or throw not implemented.
    }

    async visibility(path: string, options: MiscellaneousOptions): Promise<string> {
        return 'public';
    }

    async deleteDirectory(path: string, options: MiscellaneousOptions): Promise<void> {
        await this.runRclone(['purge', this.getRemotePath(path)]);
    }

    async fileExists(path: string, options: MiscellaneousOptions): Promise<boolean> {
        try {
            const entry = await this.stat(path, options);
            return entry.isFile;
        } catch {
            return false;
        }
    }

    async directoryExists(path: string, options: MiscellaneousOptions): Promise<boolean> {
        try {
            const entry = await this.stat(path, options);
            return entry.isDirectory;
        } catch {
            return false;
        }
    }

    async publicUrl(path: string, options: PublicUrlOptions): Promise<string> {
        const out = await this.runRclone(['link', this.getRemotePath(path)]);
        return out.trim();
    }

    async temporaryUrl(path: string, options: TemporaryUrlOptions): Promise<string> {
        throw new Error('Temporary URLs are not supported by the rclone adapter.');
    }

    async checksum(path: string, options: ChecksumOptions): Promise<string> {
        const out = await this.runRclone(['hashsum', options.algo ?? 'md5', this.getRemotePath(path)]);
        const parts = out.trim().split(/\s+/);
        return parts[0];
    }

    async mimeType(path: string, options: MimeTypeOptions): Promise<string> {
        const entry = await this.stat(path, options);
        if (entry.type === 'file') {
            // We can run lsjson to get MimeType
            const out = await this.runRclone(['lsjson', '--stat', this.getRemotePath(path)]);
            const item = JSON.parse(out);
            if (item.MimeType) {
                return item.MimeType;
            }
        }
        return 'application/octet-stream';
    }

    async lastModified(path: string, options: MiscellaneousOptions): Promise<number> {
        const entry = await this.stat(path, options);
        if (entry.lastModifiedMs === undefined) {
            throw new Error('Unable to retrieve last modified time.');
        }
        return entry.lastModifiedMs;
    }

    async fileSize(path: string, options: MiscellaneousOptions): Promise<number> {
        const entry = await this.stat(path, options);
        if (entry.type !== 'file') {
            throw new Error(`Path ${path} is not a file.`);
        }
        if (entry.size === undefined) {
            throw new Error('Unable to retrieve file size.');
        }
        return entry.size;
    }
}
