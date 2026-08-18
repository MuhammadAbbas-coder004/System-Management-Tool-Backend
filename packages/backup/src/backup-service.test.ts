import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FileStorage } from '@flystorage/file-storage';
import { InMemoryStorageAdapter } from '@flystorage/in-memory';
import { LocalStorageAdapter } from '@flystorage/local-fs';
import { BackupService } from './backup-service.js';
import { createBackupAdapter, BackupDestination } from './backup-destination.js';
import { RcloneStorageAdapter } from './rclone-storage-adapter.js';
import { execFile } from 'child_process';

vi.mock('child_process', async () => {
    const actual = await vi.importActual<any>('child_process');
    return {
        ...actual,
        execFile: vi.fn((binary: string, args: any, opts: any, callback: any) => {
            const cb = typeof opts === 'function' ? opts : callback;
            cb(null, { stdout: '[]', stderr: '' });
        }),
        spawn: vi.fn(),
    };
});

describe('Backup Factory', () => {
    it('creates a LocalStorageAdapter for local destination', () => {
        const adapter = createBackupAdapter({
            type: 'local',
            rootDirectory: '/tmp/backup',
        });
        expect(adapter).toBeInstanceOf(LocalStorageAdapter);
    });

    it('creates a RcloneStorageAdapter for external destinations', () => {
        const destTypes: BackupDestination[] = [
            { type: 'ftp', host: 'localhost', username: 'user' },
            { type: 'sftp', host: 'localhost', username: 'user' },
            { type: 'google-drive', clientId: 'cid', clientSecret: 'cs', refreshToken: 'rt' },
            { type: 'onedrive', clientId: 'cid', clientSecret: 'cs', refreshToken: 'rt' },
        ];

        for (const dest of destTypes) {
            const adapter = createBackupAdapter(dest);
            expect(adapter).toBeInstanceOf(RcloneStorageAdapter);
        }
    });
});

describe('BackupService', () => {
    it('should successfully back up files from source to destination', async () => {
        const sourceAdapter = new InMemoryStorageAdapter();
        const sourceStorage = new FileStorage(sourceAdapter);

        const destAdapter = new InMemoryStorageAdapter();
        const destStorage = new FileStorage(destAdapter);

        // Prepare source files
        await sourceStorage.write('file1.txt', 'content1');
        await sourceStorage.write('folder/file2.txt', 'content2');

        const backupService = new BackupService();
        await backupService.backup(sourceStorage, destStorage);

        // Verify destination files
        expect(await destStorage.readToString('file1.txt')).toBe('content1');
        expect(await destStorage.readToString('folder/file2.txt')).toBe('content2');
    });

    it('should abort backup process if AbortSignal is triggered', async () => {
        const sourceAdapter = new InMemoryStorageAdapter();
        const sourceStorage = new FileStorage(sourceAdapter);

        const destAdapter = new InMemoryStorageAdapter();
        const destStorage = new FileStorage(destAdapter);

        await sourceStorage.write('file1.txt', 'content1');

        const controller = new AbortController();
        controller.abort('Cancelled');

        const backupService = new BackupService();
        await expect(backupService.backup(sourceStorage, destStorage, { abortSignal: controller.signal }))
            .rejects.toBe('Cancelled');
    });
});

describe('RcloneStorageAdapter Command Delegation', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('constructs correct environment variables and calls rclone binary', async () => {
        const destination: BackupDestination = {
            type: 'sftp',
            host: 'sftp.example.com',
            port: 2222,
            username: 'myuser',
            password: 'mypassword',
        };

        const adapter = new RcloneStorageAdapter(destination, 'my-rclone');

        // Trigger a list operation
        const generator = adapter.list('my-path', { deep: true });
        await generator.next();

        // Verify correct arguments and binary were called
        expect(execFile).toHaveBeenCalled();
        const [calledBinary, calledArgs, calledOpts] = (execFile as any).mock.calls[0];
        expect(calledBinary).toBe('my-rclone');
        expect(calledArgs).toContain('lsjson');
        expect(calledArgs).toContain('--recursive');
        expect(calledArgs).toContain('flystorage_backup_remote:my-path');

        // Verify configuration environment variables
        const env = calledOpts.env;
        expect(env.RCLONE_CONFIG_FLYSTORAGE_BACKUP_REMOTE_TYPE).toBe('sftp');
        expect(env.RCLONE_CONFIG_FLYSTORAGE_BACKUP_REMOTE_HOST).toBe('sftp.example.com');
        expect(env.RCLONE_CONFIG_FLYSTORAGE_BACKUP_REMOTE_PORT).toBe('2222');
        expect(env.RCLONE_CONFIG_FLYSTORAGE_BACKUP_REMOTE_USER).toBe('myuser');
        expect(env.RCLONE_CONFIG_FLYSTORAGE_BACKUP_REMOTE_PASS).toBe('mypassword');
    });
});
