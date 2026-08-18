import { FileStorage } from '@flystorage/file-storage';

export interface BackupOptions {
    abortSignal?: AbortSignal;
}

export class BackupService {
    /**
     * Runs a backup process from a source storage to a destination storage.
     * Iterates over all files in the source storage recursively and writes them
     * to the destination storage.
     */
    async backup(
        source: FileStorage,
        destination: FileStorage,
        options: BackupOptions = {},
    ): Promise<void> {
        const sourceFiles = source.list('', { deep: true });

        for await (const file of sourceFiles) {
            if (options.abortSignal?.aborted) {
                throw options.abortSignal.reason;
            }

            if (file.isFile) {
                const stream = await source.read(file.path, { abortSignal: options.abortSignal });
                await destination.write(file.path, stream, { abortSignal: options.abortSignal });
            }
        }
    }
}
