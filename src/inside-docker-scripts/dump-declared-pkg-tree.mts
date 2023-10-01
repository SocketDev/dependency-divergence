#!/usr/bin/env node
/**
 * This script will dump the entire module graph of the CWD following package.json declarations
 * It WILL NOT xref against lockfiles
 * It WILL NOT check for extraneous modules (PR welcome)
 */

import fs from 'fs/promises'
import path, { basename, dirname, isAbsolute, relative, resolve } from 'path'

await walk(process.cwd() as FilePath)

type PackageName = string & { _tag: 'PackageName' }
type PackageVersion = string & { _tag: 'PackageVersion' }
type PackageVersionConstraint = string & { _tag: 'PackageVersionConstraint' }
type DependencyDeclarations = Record<PackageName, PackageVersionConstraint>
type PackageManifest = {
    name: PackageName | null,
    version: PackageVersion | null,
    dependencies: DependencyDeclarations | null,
    devDependencies: DependencyDeclarations | null,
    optionalDependencies: DependencyDeclarations | null,
    peerDependencies: DependencyDeclarations | null
}
type FilePath = string & { _tag: 'FilePath' }
type ManifestIndex = number & { _tag: 'ManifestIndex' }
type GraphIndex = number & { _tag: 'GraphIndex' }
type ManifestEntry = {
    manifestPath: FilePath,
    manifest: PackageManifest | null
}
type PackageDeclarations = {
    dependencies?: string,
    devDependencies?: string,
    peerDependencies?: string,
    optionalDependencies?: string
}

async function walk(rootdir: FilePath) {
    if (!isAbsolute(rootdir)) {
        throw new Error('Must start with absolute path')
    }
    const rootManifestPath = path.join(rootdir, 'package.json') as FilePath
    const rootManifest = getJSONManifestInfo(JSON.parse(await fs.readFile(rootManifestPath, 'utf-8')))
    const manifests: ManifestEntry[] = [{
        manifestPath: rootManifestPath,
        manifest: rootManifest
    }]
    const graph: {
        declaration: PackageDeclarations | null,
        prev: GraphIndex | null,
        // this can differ from the disk due to aliasing rules so track oob
        name: PackageName | null,
        resolvedManifestIndex: ManifestIndex,
    }[] = [{
        declaration: null,
        prev: null,
        name: rootManifest?.name ?? null,
        resolvedManifestIndex: 0 as ManifestIndex
    }]
    const seen = new Map()
    for (let to_visit = 0 as GraphIndex; to_visit < graph.length; to_visit++) {
        const edge = graph[to_visit]
        const {
            manifestPath,
            manifest
        } = manifests[edge.resolvedManifestIndex]
        if (manifest && 'package.json' === basename(manifestPath).toLocaleLowerCase()) {
            const pkgKeys = [
                'dependencies',
                // 'devDependencies',
                // 'optionalDependencies',
                // 'peerDependencies',
            ] as const
            const declarations: Map<PackageName, PackageDeclarations> = new Map()
            for (const pkgJSONKey of pkgKeys) {
                const field = manifest[pkgJSONKey]
                if (typeof field !== 'object' || !field) {
                    continue
                }
                for (const [pkgName, constraint] of Object.entries(field) as [PackageName, PackageVersionConstraint][]) {
                    const existing = declarations.get(pkgName) ?? Object.create(null) as PackageDeclarations
                    declarations.set(pkgName, existing)
                    existing[pkgJSONKey] = constraint
                }
            }
            for await (const resolved of findPackages(declarations.keys(), await fs.realpath(dirname(manifestPath)) as FilePath)) {
                const newManifestIndex = seen.get(resolved.manifestPath) ?? (manifests.push({
                    manifest: resolved.manifest,
                    manifestPath: resolved.manifestPath
                }) - 1 as ManifestIndex)
                const name = resolved.trueName
                const declaration = declarations.get(name)
                if (declaration) {
                    declarations.delete(name)
                    graph.push({
                        declaration,
                        prev: to_visit,
                        name,
                        resolvedManifestIndex: newManifestIndex,
                    })
                }
            }
        }
    }
    for (const edge of graph) {
        const backEdges = []
        let needle = edge
        while (needle) {
            backEdges.push(needle)
            if (needle.prev === null) break
            needle = graph[needle.prev]
        }
        const dependencyPath = (backEdges.reverse().map(e => {
            return e.name
        }))
        const manifest = manifests[edge.resolvedManifestIndex].manifest
        const version = manifest?.version ?? null
        process.stdout.write(`${JSON.stringify({
            type: 'declared',
            trueName: manifest?.name ?? null,
            dependencyPath,
            version
        })}\n`)
    }
}

function toPackageNameVersionRecord (json: object | null) {
    if (!json) {
        return null
    }
    const ret: Record<PackageName, PackageVersionConstraint> = Object.create(null)
    for (const [pkgName, pkgConstraint] of Object.entries(json)) {
        ret[pkgName as PackageName] = pkgConstraint as PackageVersionConstraint
    }
    return ret
}
function getJSONManifestInfo (json: any) {
    if (typeof json !== 'object' || !json) {
        return null
    }
    const name = typeof json.name === 'string' ? json.name as PackageName : null
    const version = typeof json.version === 'string' ? json.version as PackageVersion : null
    const dependencies = typeof json.dependencies === 'object' && json.dependencies ? json.dependencies : null
    const devDependencies = typeof json.devDependencies === 'object' && json.devDependencies ? json.devDependencies : null
    const optionalDependencies = typeof json.optionalDependencies === 'object' && json.optionalDependencies ? json.optionalDependencies : null
    const peerDependencies = typeof json.peerDependencies === 'object' && json.peerDependencies ? json.peerDependencies : null
    return {
        name,
        version,
        dependencies: toPackageNameVersionRecord(dependencies),
        devDependencies: toPackageNameVersionRecord(devDependencies),
        optionalDependencies: toPackageNameVersionRecord(optionalDependencies),
        peerDependencies: toPackageNameVersionRecord(peerDependencies)
    }
}

async function* findPackages(names: Iterable<PackageName>, startDir: FilePath) {
    // sort is to cause graph to be in more human readable form
    const pendingNames = new Set([...names].sort())
    // const debugme = startDir.endsWith('/tar-stream')
    let previous = null
    let visiting = path.join(startDir, 'node_modules')
    while (previous !== visiting) {
        each_pending_name:
        for (const pendingName of pendingNames) {
            const possibleDir = path.join(visiting, pendingName)
            const manifestPath = path.join(possibleDir, 'package.json') as FilePath
            let manifest: PackageManifest | null
            try {
                manifest = getJSONManifestInfo(JSON.parse(await fs.readFile(manifestPath, 'utf-8')))
            } catch (e) {
                if (e && typeof e === 'object' && 'code' in e && e.code === 'ENOENT') {
                    continue each_pending_name
                } else {
                    throw e
                }
            }
            pendingNames.delete(pendingName)
            yield { manifest, manifestPath, trueName: pendingName }
        }
        previous = visiting
        visiting = path.join(visiting, '..')
    }
}
