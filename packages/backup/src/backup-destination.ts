import { StorageAdapter } from '@flystorage/file-storage';
import { LocalStorageAdapter } from '@flystorage/local-fs';
import { RcloneStorageAdapter } from './rclone-storage-adapter.js';

export interface LocalBackupDestination {
    type: 'local';
    rootDirectory: string;
}

export interface FtpBackupDestination {
    type: 'ftp';
    host: string;
    port?: number;
    username: string;
    password?: string;
}

export interface SftpBackupDestination {
    type: 'sftp';
    host: string;
    port?: number;
    username: string;
    password?: string;
    privateKey?: string;
}

export interface GoogleDriveBackupDestination {
    type: 'google-drive';
    clientId: string;
    clientSecret: string;
    refreshToken: string;
    folderId?: string;
}

export interface OneDriveBackupDestination {
    type: 'onedrive';
    clientId: string;
    clientSecret: string;
    refreshToken: string;
    drivePath?: string;
}

export type BackupDestination =
    | LocalBackupDestination
    | FtpBackupDestination
    | SftpBackupDestination
    | GoogleDriveBackupDestination
    | OneDriveBackupDestination;

export function createBackupAdapter(destination: BackupDestination): StorageAdapter {
    switch (destination.type) {
        case 'local':
            return new LocalStorageAdapter(destination.rootDirectory);
        case 'ftp':
        case 'sftp':
        case 'google-drive':
        case 'onedrive':
            return new RcloneStorageAdapter(destination);
        default:
            throw new Error(`Unsupported backup destination type: ${(destination as any).type}`);
    }
}
