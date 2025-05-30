// @ts-expect-error: toSource may not have types
import toSource from 'tosource';
// @ts-ignore: Node.js types
/// <reference types="node" />
import { namespaces } from '../../lib/registry';
import { RadarItem } from '../../lib/types';
import { parse } from 'tldts';
import fs from 'fs/promises';
import path from 'path';
import { getCurrentPath } from '../../lib/utils/helpers';

const __dirname = getCurrentPath(import.meta.url);

async function ensureDirectoryExists(dirPath: string) {
    try {
        await fs.mkdir(dirPath, { recursive: true });
    } catch (error) {
        console.error(`Error creating directory ${dirPath}:`, error);
    }
}

async function writeJsonFile(filePath: string, data: any) {
    try {
        await fs.writeFile(filePath, JSON.stringify(data, null, 2));
        console.log(`Successfully wrote ${filePath}`);
    } catch (error) {
        console.error(`Error writing ${filePath}:`, error);
    }
}

async function main() {
    const maintainers: Record<string, string[]> = {};
    const radar: {
        [domain: string]: {
            _name: string;
            [subdomain: string]: RadarItem[] | string;
        };
    } = {};

    for (const namespace in namespaces) {
        let defaultCategory = namespaces[namespace].categories?.[0];
        if (!defaultCategory) {
            for (const path in namespaces[namespace].routes) {
                if (namespaces[namespace].routes[path].categories) {
                    defaultCategory = namespaces[namespace].routes[path].categories[0];
                    break;
                }
            }
        }
        if (!defaultCategory) {
            defaultCategory = 'other';
        }
        for (const path in namespaces[namespace].routes) {
            const realPath = `/${namespace}${path}`;
            const data = namespaces[namespace].routes[path];
            const categories = data.categories || namespaces[namespace].categories || [defaultCategory];
            // maintainers
            if (data.maintainers) {
                maintainers[realPath] = data.maintainers;
            }
            // radar
            if (data.radar?.length) {
                for (const radarItem of data.radar) {
                    const parsedDomain = parse(new URL('https://' + radarItem.source[0]).hostname);
                    const subdomain = parsedDomain.subdomain || '.';
                    const domain = parsedDomain.domain;
                    if (domain) {
                        if (!radar[domain]) {
                            radar[domain] = {
                                _name: namespaces[namespace].name,
                            };
                        }
                        if (!radar[domain][subdomain]) {
                            radar[domain][subdomain] = [];
                        }
                        // Type guard for push
                        if (Array.isArray(radar[domain][subdomain])) {
                            (radar[domain][subdomain] as RadarItem[]).push({
                                title: radarItem.title || data.name,
                                docs: `https://docs.rsshub.app/routes/${categories[0]}`,
                                source: radarItem.source.map((source) => {
                                    const sourceURL = new URL('https://' + source);
                                    return sourceURL.pathname + sourceURL.search + sourceURL.hash;
                                }),
                                target: radarItem.target ? `/${namespace}${radarItem.target}` : realPath,
                            });
                        }
                    }
                }
            }
            data.module = `() => import('@/routes/${namespace}/${data.location}')`;
        }
        for (const path in namespaces[namespace].apiRoutes) {
            const data = namespaces[namespace].apiRoutes[path];
            data.module = `() => import('@/routes/${namespace}/${data.location}')`;
        }
    }

    // Use process.cwd() to get the absolute path to the project root
    const projectRoot = process.cwd();
    const buildDir = path.join(projectRoot, 'assets', 'build');

    // Ensure the build directory exists
    await ensureDirectoryExists(buildDir);

    // Write files using absolute paths
    await writeJsonFile(path.join(buildDir, 'radar-rules.json'), radar);
    await fs.writeFile(path.join(buildDir, 'radar-rules.js'), `(${toSource(radar)})`);
    await writeJsonFile(path.join(buildDir, 'maintainers.json'), maintainers);
    await writeJsonFile(path.join(buildDir, 'routes.json'), namespaces);
    await fs.writeFile(path.join(buildDir, 'routes.js'), `export default ${JSON.stringify(namespaces, null, 2)}`.replaceAll(/"module": "(.*)"\n/g, '"module": $1\n'));
}

main().catch(error => {
    console.error('An error occurred during the build process:', error);
    process.exit(1);
});
