import type { APIRoute, Namespace, Route } from '@/types';
import { directoryImport } from 'directory-import';
import { Hono, type Handler } from 'hono';
import path from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import { config } from '@/config';
import fs from 'node:fs';

import index from '@/routes/index';
import healthz from '@/routes/healthz';
import robotstxt from '@/routes/robots.txt';
import metrics from '@/routes/metrics';

const __dirname = import.meta.dirname;

let modules: Record<string, { route: Route } | { namespace: Namespace }> = {};
let namespaces: Record<
    string,
    Namespace & {
        routes: Record<
            string,
            Route & {
                location: string;
            }
        >;
        apiRoutes: Record<
            string,
            APIRoute & {
                location: string;
            }
        >;
    }
> = {};

async function loadNamespaces() {
    switch (process.env.NODE_ENV) {
        case 'test':
        case 'production':
            try {
                const routesPath = path.join(process.cwd(), 'assets', 'build', 'routes.json');
                if (fs.existsSync(routesPath)) {
                    const routesContent = await fs.promises.readFile(routesPath, 'utf-8');
                    namespaces = JSON.parse(routesContent);
                } else {
                    console.warn('routes.json not found. Falling back to directory import.');
                    await loadModules();
                }
            } catch (error) {
                console.error('Error loading routes.json:', error);
                await loadModules();
            }
            break;
        default:
            await loadModules();
    }
}

async function loadModules() {
    modules = directoryImport({
        targetDirectoryPath: path.join(__dirname, './routes'),
        importPattern: /\.ts$/,
    }) as typeof modules;

    for (const module in modules) {
        const content = modules[module] as
            | {
                  route: Route;
              }
            | {
                  namespace: Namespace;
              }
            | {
                  apiRoute: APIRoute;
              };
        const namespace = module.split(/[/\\]/)[1];
        if ('namespace' in content) {
            namespaces[namespace] = Object.assign(
                {
                    routes: {},
                },
                namespaces[namespace],
                content.namespace
            );
        } else if ('route' in content) {
            if (!namespaces[namespace]) {
                namespaces[namespace] = {
                    name: namespace,
                    routes: {},
                    apiRoutes: {},
                };
            }
            if (Array.isArray(content.route.path)) {
                for (const path of content.route.path) {
                    namespaces[namespace].routes[path] = {
                        ...content.route,
                        location: module.split(/[/\\]/).slice(2).join('/'),
                    };
                }
            } else {
                namespaces[namespace].routes[content.route.path] = {
                    ...content.route,
                    location: module.split(/[/\\]/).slice(2).join('/'),
                };
            }
        } else if ('apiRoute' in content) {
            if (!namespaces[namespace]) {
                namespaces[namespace] = {
                    name: namespace,
                    routes: {},
                    apiRoutes: {},
                };
            }
            if (Array.isArray(content.apiRoute.path)) {
                for (const path of content.apiRoute.path) {
                    namespaces[namespace].apiRoutes[path] = {
                        ...content.apiRoute,
                        location: module.split(/[/\\]/).slice(2).join('/'),
                    };
                }
            } else {
                namespaces[namespace].apiRoutes[content.apiRoute.path] = {
                    ...content.apiRoute,
                    location: module.split(/[/\\]/).slice(2).join('/'),
                };
            }
        }
    }
}

await loadNamespaces();

export { namespaces };

const app = new Hono();
const sortRoutes = (
    routes: Record<
        string,
        Route & {
            location: string;
            module?: () => Promise<{ route: Route }>;
        }
    >
) =>
    Object.entries(routes).sort(([pathA], [pathB]) => {
        const segmentsA = pathA.split('/');
        const segmentsB = pathB.split('/');
        const lenA = segmentsA.length;
        const lenB = segmentsB.length;
        const minLen = Math.min(lenA, lenB);

        for (let i = 0; i < minLen; i++) {
            const segmentA = segmentsA[i];
            const segmentB = segmentsB[i];

            // Literal segments have priority over parameter segments
            if (segmentA.startsWith(':') !== segmentB.startsWith(':')) {
                return segmentA.startsWith(':') ? 1 : -1;
            }
        }

        return 0;
    });

for (const namespace in namespaces) {
    const subApp = app.basePath(`/${namespace}`);

    const namespaceData = namespaces[namespace];
    if (!namespaceData || !namespaceData.routes) {
        continue;
    }

    const sortedRoutes = sortRoutes(namespaceData.routes);

    for (const [path, routeData] of sortedRoutes) {
        const wrappedHandler: Handler = async (ctx) => {
            if (!ctx.get('data')) {
                if (typeof routeData.handler !== 'function') {
                    if (process.env.NODE_ENV === 'test') {
                        const { route } = await import(`./routes/${namespace}/${routeData.location}`);
                        routeData.handler = route.handler;
                    } else if (routeData.module) {
                        const { route } = await routeData.module();
                        routeData.handler = route.handler;
                    }
                }
                ctx.set('data', await routeData.handler(ctx));
            }
        };
        subApp.get(path, wrappedHandler);
    }
}

for (const namespace in namespaces) {
    const subApp = app.basePath(`/api/${namespace}`);

    const namespaceData = namespaces[namespace];
    if (!namespaceData || !namespaceData.apiRoutes) {
        continue;
    }

    const sortedRoutes = Object.entries(namespaceData.apiRoutes) as [
        string,
        APIRoute & {
            location: string;
            module?: () => Promise<{ apiRoute: APIRoute }>;
        },
    ][];

    for (const [path, routeData] of sortedRoutes) {
        const wrappedHandler: Handler = async (ctx) => {
            if (!ctx.get('apiData')) {
                if (typeof routeData.handler !== 'function') {
                    if (process.env.NODE_ENV === 'test') {
                        const { apiRoute } = await import(`./routes/${namespace}/${routeData.location}`);
                        routeData.handler = apiRoute.handler;
                    } else if (routeData.module) {
                        const { apiRoute } = await routeData.module();
                        routeData.handler = apiRoute.handler;
                    }
                }
                const data = await routeData.handler(ctx);
                ctx.set('apiData', data);
            }
        };
        subApp.get(path, wrappedHandler);
    }
}

app.get('/', index);
app.get('/healthz', healthz);
app.get('/robots.txt', robotstxt);
if (config.debugInfo) {
    // Only enable tracing in debug mode
    app.get('/metrics', metrics);
}
app.use(
    '/*',
    serveStatic({
        root: './lib/assets',
        rewriteRequestPath: (path) => (path === '/favicon.ico' ? '/favicon.png' : path),
    })
);

export default app;
