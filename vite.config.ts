import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const warehouseRoot = resolve(process.cwd(), process.env.ASSET_FORGE_WAREHOUSE_DIR ?? 'project-warehouse');

const safeName = (value: string) => value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'item';

const warehousePlugin = () => ({
  name: 'local-warehouse-api',
  configureServer(server) {
    server.middlewares.use('/__warehouse/save', async (request, response) => {
      if (request.method !== 'POST') {
        response.statusCode = 405;
        response.end();
        return;
      }

      let body = '';
      request.on('data', (chunk) => {
        body += String(chunk);
      });
      request.on('end', async () => {
        try {
          const parsed = JSON.parse(body);
          const projectId = safeName(String(parsed.projectId ?? 'default-project'));
          const items = Array.isArray(parsed.items) ? parsed.items : [];
          const projectDir = join(warehouseRoot, projectId);
          await mkdir(projectDir, { recursive: true });

          const manifestPath = join(projectDir, 'manifest.json');
          let manifest = { projectId, items: [] };
          try {
            manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
          } catch {
            manifest = { projectId, items: [] };
          }

          const existing = new Set(manifest.items.map((item) => item.key));
          let saved = 0;
          let skipped = 0;
          for (const entry of items) {
            const key = safeName(String(entry.key ?? entry.item?.id ?? randomUUID()));
            const fileName = `${key}.assetpart.json`;
            if (existing.has(key)) {
              skipped += 1;
              continue;
            }
            const payload = JSON.stringify(entry.item, null, 2);
            await writeFile(join(projectDir, fileName), payload, 'utf8');
            manifest.items.push({
              key,
              fileName,
              name: entry.item?.name ?? key,
              itemType: entry.item?.itemType ?? 'part',
              category: entry.item?.category ?? 'General',
              className: entry.item?.className ?? 'Component',
              savedAt: new Date().toISOString(),
              sizeBytes: Buffer.byteLength(payload),
            });
            existing.add(key);
            saved += 1;
          }

          await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
          response.setHeader('Content-Type', 'application/json');
          response.end(JSON.stringify({ saved, skipped, manifest }));
        } catch (error) {
          response.statusCode = 500;
          response.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Warehouse save failed' }));
        }
      });
    });

    server.middlewares.use('/__warehouse/save-glb', async (request, response) => {
      if (request.method !== 'POST') {
        response.statusCode = 405;
        response.end();
        return;
      }

      const chunks: Buffer[] = [];
      request.on('data', (chunk) => {
        chunks.push(Buffer.from(chunk));
      });
      request.on('end', async () => {
        try {
          const url = new URL(request.url ?? '', 'http://127.0.0.1');
          const projectId = safeName(String(url.searchParams.get('projectId') ?? 'default-project'));
          const key = safeName(String(url.searchParams.get('key') ?? randomUUID()));
          const overwrite = url.searchParams.get('overwrite') === '1';
          const projectDir = join(warehouseRoot, projectId);
          await mkdir(projectDir, { recursive: true });

          const manifestPath = join(projectDir, 'manifest.json');
          let manifest = { projectId, items: [] };
          try {
            manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
          } catch {
            manifest = { projectId, items: [] };
          }

          const existingIndex = manifest.items.findIndex((item) => item.key === key);
          if (existingIndex >= 0 && !overwrite) {
            response.setHeader('Content-Type', 'application/json');
            response.end(JSON.stringify({ saved: 0, skipped: 1, manifest }));
            return;
          }

          const previousFileName = existingIndex >= 0 ? manifest.items[existingIndex]?.fileName : undefined;
          const fileName = previousFileName && String(previousFileName).toLowerCase().endsWith('.glb') ? previousFileName : `${key}.glb`;
          const payload = Buffer.concat(chunks);
          await writeFile(join(projectDir, fileName), payload);
          const nextEntry = {
            key,
            fileName,
            name: key,
            itemType: 'part',
            category: 'General',
            className: 'Component',
            savedAt: new Date().toISOString(),
            sizeBytes: payload.byteLength,
          };
          if (existingIndex >= 0) manifest.items[existingIndex] = { ...manifest.items[existingIndex], ...nextEntry };
          else manifest.items.push(nextEntry);

          await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
          response.setHeader('Content-Type', 'application/json');
          response.end(JSON.stringify({ saved: 1, skipped: 0, replaced: existingIndex >= 0 ? 1 : 0, manifest }));
        } catch (error) {
          response.statusCode = 500;
          response.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Warehouse GLB save failed' }));
        }
      });
    });

    server.middlewares.use('/__warehouse/metadata', async (request, response) => {
      if (request.method !== 'POST') {
        response.statusCode = 405;
        response.end();
        return;
      }

      let body = '';
      request.on('data', (chunk) => {
        body += String(chunk);
      });
      request.on('end', async () => {
        try {
          const parsed = JSON.parse(body || '{}');
          const projectId = safeName(String(parsed.projectId ?? 'default-project'));
          const key = safeName(String(parsed.key ?? ''));
          const metadata = parsed.metadata ?? {};
          const projectDir = join(warehouseRoot, projectId);
          const manifestPath = join(projectDir, 'manifest.json');
          const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
          const index = Array.isArray(manifest.items) ? manifest.items.findIndex((item) => item.key === key) : -1;
          if (index < 0) {
            response.setHeader('Content-Type', 'application/json');
            response.end(JSON.stringify({ updated: 0 }));
            return;
          }

          manifest.items[index] = {
            ...manifest.items[index],
            name: metadata.name ?? manifest.items[index].name,
            itemType: metadata.itemType ?? manifest.items[index].itemType,
            category: metadata.category ?? manifest.items[index].category,
            className: metadata.className ?? manifest.items[index].className,
            code: metadata.code,
            objectName: metadata.objectName,
            sourceAssetName: metadata.sourceAssetName,
            material: metadata.material,
            thumbnailDataUrl: metadata.thumbnailDataUrl,
            functionalComponent: metadata.functionalComponent,
            functionalAssembly: metadata.functionalAssembly,
            savedAt: new Date().toISOString(),
          };
          await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
          response.setHeader('Content-Type', 'application/json');
          response.end(JSON.stringify({ updated: 1, manifest }));
        } catch (error) {
          response.statusCode = 500;
          response.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Warehouse metadata save failed' }));
        }
      });
    });

    server.middlewares.use('/__warehouse/load', async (request, response) => {
      try {
        const url = new URL(request.url ?? '', 'http://127.0.0.1');
        const projectId = safeName(String(url.searchParams.get('projectId') ?? 'default-project'));
        const projectDir = join(warehouseRoot, projectId);
        const manifestPath = join(projectDir, 'manifest.json');
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
        const items = [];
        for (const entry of manifest.items ?? []) {
          if (String(entry.fileName).toLowerCase().endsWith('.glb')) {
            const buffer = await readFile(join(projectDir, entry.fileName));
            const geometry = {
              kind: 'imported-model',
              assetName: entry.fileName,
              assetDataUrl: `data:model/gltf-binary;base64,${buffer.toString('base64')}`,
              sourceFormat: 'glb',
              importScale: 1,
              importOffset: [0, 0, 0],
              originalBounds: [1, 1, 1],
              normalizedBounds: [1, 1, 1],
              bones: [],
              animations: [],
              joints: [],
              validatedMotions: [],
              freePartTransforms: [],
              partMaterials: [],
              isolatedObjectNames: [],
              partObjectNames: [],
            };
            const material = entry.material ?? { name: 'Stored GLB', color: '#8b949e', roughness: 0.52, metalness: 0.08 };
            const storageMetadata = {
              sourceFormat: 'glb',
              originalBounds: [1, 1, 1],
              storedAt: entry.savedAt,
              updatedAt: entry.savedAt,
              storageKey: entry.key,
              storageProjectId: projectId,
              storageFileName: entry.fileName,
            };

            if (entry.itemType === 'assembly') {
              items.push({
                id: `assembly_${entry.key}`,
                itemType: 'assembly',
                thumbnailDataUrl: entry.thumbnailDataUrl,
                code: entry.code ?? entry.key,
                name: entry.name,
                category: 'Assemblies',
                className: entry.className ?? 'Composite',
                sourceAssetName: entry.sourceAssetName ?? entry.fileName,
                assemblyNodes: [
                  {
                    id: `node_${entry.key}`,
                    name: entry.name,
                    geometry,
                    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
                    material,
                    visible: true,
                    locked: false,
                    createdAt: entry.savedAt,
                  },
                ],
                functionalAssembly: entry.functionalAssembly,
                metadata: {
                  ...storageMetadata,
                  sourceFormat: 'assembly',
                },
              });
              continue;
            }

            items.push({
              id: `part_${entry.key}`,
              itemType: 'part',
              thumbnailDataUrl: entry.thumbnailDataUrl,
              code: entry.code ?? entry.key,
              name: entry.name,
              category: entry.category ?? 'General',
              className: entry.className ?? 'Component',
              sourceNodeId: `file_${entry.key}`,
              sourceAssetName: entry.sourceAssetName ?? entry.fileName,
              objectName: entry.objectName ?? entry.name,
              geometry,
              material,
              functionalComponent: entry.functionalComponent,
              metadata: {
                ...storageMetadata,
                sourceFormat: 'glb',
              },
            });
          } else {
            items.push(JSON.parse(await readFile(join(projectDir, entry.fileName), 'utf8')));
          }
        }
        const files = await readdir(projectDir).catch(() => []);
        const usageBytes = (
          await Promise.all(
            files.map(async (fileName) => {
              const info = await stat(join(projectDir, fileName));
              return info.size;
            }),
          )
        ).reduce((total, size) => total + size, 0);
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ manifest, items, usageBytes }));
      } catch {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ manifest: { items: [] }, items: [], usageBytes: 0 }));
      }
    });

    server.middlewares.use('/__warehouse/projects', async (request, response) => {
      if (request.method !== 'GET') {
        response.statusCode = 405;
        response.end();
        return;
      }

      try {
        const projectNames = await readdir(warehouseRoot).catch(() => []);
        const projects = [];
        for (const projectId of projectNames) {
          const projectDir = join(warehouseRoot, projectId);
          const info = await stat(projectDir).catch(() => undefined);
          if (!info?.isDirectory()) continue;

          const manifestPath = join(projectDir, 'manifest.json');
          const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
          const files = await readdir(projectDir).catch(() => []);
          const usageBytes = (
            await Promise.all(
              files.map(async (fileName) => {
                const fileInfo = await stat(join(projectDir, fileName));
                return fileInfo.size;
              }),
            )
          ).reduce((total, size) => total + size, 0);
          const items = Array.isArray(manifest.items) ? manifest.items : [];
          const latestSavedAt = items
            .map((item) => String(item.savedAt ?? ''))
            .filter(Boolean)
            .sort()
            .at(-1);

          projects.push({
            projectId,
            items: items.length,
            usageBytes,
            latestSavedAt: latestSavedAt ?? info.mtime.toISOString(),
          });
        }

        projects.sort((a, b) => b.latestSavedAt.localeCompare(a.latestSavedAt));
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ projects }));
      } catch (error) {
        response.statusCode = 500;
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Warehouse projects load failed' }));
      }
    });

    server.middlewares.use('/__warehouse/delete', async (request, response) => {
      if (request.method !== 'POST') {
        response.statusCode = 405;
        response.end();
        return;
      }

      let body = '';
      request.on('data', (chunk) => {
        body += String(chunk);
      });
      request.on('end', async () => {
        try {
          const parsed = JSON.parse(body || '{}');
          const projectId = safeName(String(parsed.projectId ?? 'default-project'));
          const key = safeName(String(parsed.key ?? ''));
          const projectDir = join(warehouseRoot, projectId);
          const manifestPath = join(projectDir, 'manifest.json');
          const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
          const index = Array.isArray(manifest.items) ? manifest.items.findIndex((item) => item.key === key) : -1;
          if (index < 0) {
            response.setHeader('Content-Type', 'application/json');
            response.end(JSON.stringify({ deleted: 0 }));
            return;
          }

          const [entry] = manifest.items.splice(index, 1);
          if (entry?.fileName) {
            await unlink(join(projectDir, entry.fileName)).catch(() => undefined);
          }
          await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
          response.setHeader('Content-Type', 'application/json');
          response.end(JSON.stringify({ deleted: 1, manifest }));
        } catch (error) {
          response.statusCode = 500;
          response.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Warehouse delete failed' }));
        }
      });
    });

    server.middlewares.use('/__warehouse/thumbnail', async (request, response) => {
      if (request.method !== 'POST') {
        response.statusCode = 405;
        response.end();
        return;
      }

      let body = '';
      request.on('data', (chunk) => {
        body += String(chunk);
      });
      request.on('end', async () => {
        try {
          const parsed = JSON.parse(body || '{}');
          const projectId = safeName(String(parsed.projectId ?? 'default-project'));
          const key = safeName(String(parsed.key ?? ''));
          const thumbnailDataUrl = String(parsed.thumbnailDataUrl ?? '');
          const projectDir = join(warehouseRoot, projectId);
          const manifestPath = join(projectDir, 'manifest.json');
          const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
          const index = Array.isArray(manifest.items) ? manifest.items.findIndex((item) => item.key === key) : -1;
          if (index < 0 || !thumbnailDataUrl.startsWith('data:image/')) {
            response.setHeader('Content-Type', 'application/json');
            response.end(JSON.stringify({ updated: 0 }));
            return;
          }

          manifest.items[index] = { ...manifest.items[index], thumbnailDataUrl };
          await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
          response.setHeader('Content-Type', 'application/json');
          response.end(JSON.stringify({ updated: 1 }));
        } catch (error) {
          response.statusCode = 500;
          response.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Warehouse thumbnail save failed' }));
        }
      });
    });
  },
});

export default defineConfig({
  plugins: [react(), warehousePlugin()],
  server: {
    port: 5173,
  },
});
