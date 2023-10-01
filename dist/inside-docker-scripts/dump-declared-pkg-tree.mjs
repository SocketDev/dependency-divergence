#!/usr/bin/env node
/**
 * This script will dump the entire module graph of the CWD following package.json declarations
 * It WILL NOT xref against lockfiles
 * It WILL NOT check for extraneous modules (PR welcome)
 */
import fs from 'fs/promises';
import path, { basename, dirname, isAbsolute, relative, resolve } from 'path';
await walk(process.cwd());
async function walk(rootdir) {
    if (!isAbsolute(rootdir)) {
        throw new Error('Must start with absolute path');
    }
    const rootManifestPath = path.join(rootdir, 'package.json');
    const rootManifest = getJSONManifestInfo(JSON.parse(await fs.readFile(rootManifestPath, 'utf-8')));
    const manifests = [{
            manifestPath: rootManifestPath,
            manifest: rootManifest
        }];
    const graph = [{
            declaration: null,
            prev: null,
            name: rootManifest?.name ?? null,
            resolvedManifestIndex: 0
        }];
    const seen = new Map();
    for (let to_visit = 0; to_visit < graph.length; to_visit++) {
        const edge = graph[to_visit];
        const { manifestPath, manifest } = manifests[edge.resolvedManifestIndex];
        if (manifest && 'package.json' === basename(manifestPath).toLocaleLowerCase()) {
            const pkgKeys = [
                'dependencies',
                // 'devDependencies',
                // 'optionalDependencies',
                // 'peerDependencies',
            ];
            const declarations = new Map();
            for (const pkgJSONKey of pkgKeys) {
                const field = manifest[pkgJSONKey];
                if (typeof field !== 'object' || !field) {
                    continue;
                }
                for (const [pkgName, constraint] of Object.entries(field)) {
                    const existing = declarations.get(pkgName) ?? Object.create(null);
                    declarations.set(pkgName, existing);
                    existing[pkgJSONKey] = constraint;
                }
            }
            for await (const resolved of findPackages(declarations.keys(), await fs.realpath(dirname(manifestPath)))) {
                const newManifestIndex = seen.get(resolved.manifestPath) ?? manifests.push({
                    manifest: resolved.manifest,
                    manifestPath: resolved.manifestPath
                }) - 1;
                const name = resolved.trueName;
                const declaration = declarations.get(name);
                if (declaration) {
                    declarations.delete(name);
                    graph.push({
                        declaration,
                        prev: to_visit,
                        name,
                        resolvedManifestIndex: newManifestIndex,
                    });
                }
            }
        }
    }
    for (const edge of graph) {
        const backEdges = [];
        let needle = edge;
        while (needle) {
            backEdges.push(needle);
            if (needle.prev === null)
                break;
            needle = graph[needle.prev];
        }
        const dependencyPath = (backEdges.reverse().map(e => {
            return e.name;
        }));
        const manifest = manifests[edge.resolvedManifestIndex].manifest;
        const version = manifest?.version ?? null;
        process.stdout.write(`${JSON.stringify({
            type: 'declared',
            trueName: manifest?.name ?? null,
            dependencyPath,
            version
        })}\n`);
    }
}
function toPackageNameVersionRecord(json) {
    if (!json) {
        return null;
    }
    const ret = Object.create(null);
    for (const [pkgName, pkgConstraint] of Object.entries(json)) {
        ret[pkgName] = pkgConstraint;
    }
    return ret;
}
function getJSONManifestInfo(json) {
    if (typeof json !== 'object' || !json) {
        return null;
    }
    const name = typeof json.name === 'string' ? json.name : null;
    const version = typeof json.version === 'string' ? json.version : null;
    const dependencies = typeof json.dependencies === 'object' && json.dependencies ? json.dependencies : null;
    const devDependencies = typeof json.devDependencies === 'object' && json.devDependencies ? json.devDependencies : null;
    const optionalDependencies = typeof json.optionalDependencies === 'object' && json.optionalDependencies ? json.optionalDependencies : null;
    const peerDependencies = typeof json.peerDependencies === 'object' && json.peerDependencies ? json.peerDependencies : null;
    return {
        name,
        version,
        dependencies: toPackageNameVersionRecord(dependencies),
        devDependencies: toPackageNameVersionRecord(devDependencies),
        optionalDependencies: toPackageNameVersionRecord(optionalDependencies),
        peerDependencies: toPackageNameVersionRecord(peerDependencies)
    };
}
async function* findPackages(names, startDir) {
    // sort is to cause graph to be in more human readable form
    const pendingNames = new Set([...names].sort());
    // const debugme = startDir.endsWith('/tar-stream')
    let previous = null;
    let visiting = path.join(startDir, 'node_modules');
    while (previous !== visiting) {
        each_pending_name: for (const pendingName of pendingNames) {
            const possibleDir = path.join(visiting, pendingName);
            const manifestPath = path.join(possibleDir, 'package.json');
            let manifest;
            try {
                manifest = getJSONManifestInfo(JSON.parse(await fs.readFile(manifestPath, 'utf-8')));
            }
            catch (e) {
                if (e && typeof e === 'object' && 'code' in e && e.code === 'ENOENT') {
                    continue each_pending_name;
                }
                else {
                    throw e;
                }
            }
            pendingNames.delete(pendingName);
            yield { manifest, manifestPath, trueName: pendingName };
        }
        previous = visiting;
        visiting = path.join(visiting, '..');
    }
}
