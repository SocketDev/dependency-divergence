#!/usr/bin/env node
import * as tar from "tar-stream";
import fs from "fs/promises";
import { arrayBuffer, text } from "stream/consumers";
import { allocRunner, manifestFiles, lockfileFiles, } from "./template.mjs";
import { spawnSync } from "child_process";
import { basename, join } from "path";
import * as allRunners from "./runners/all.mjs";
import { partitionBy } from "./partitionBy.mjs";
//#endregion
// NOTE: this is not the most efficient, this is intended to mitigate
// noisy neighbor problems
async function* runSuite(files) {
    let withLockfilesTarball;
    let withoutLockfilesTarball;
    {
        const withoutLockfilesTarballPacker = tar.pack();
        const withLockfilesTarballPacker = tar.pack();
        for (const [path, buf] of files) {
            const isLockFile = lockfileFiles.has(basename(path));
            if (isLockFile) {
                withLockfilesTarballPacker.entry({ name: path }, buf);
            }
            else {
                withLockfilesTarballPacker.entry({ name: path }, buf);
                withoutLockfilesTarballPacker.entry({ name: path }, buf);
            }
        }
        withLockfilesTarballPacker.finalize();
        withoutLockfilesTarballPacker.finalize();
        withLockfilesTarball = Buffer.from(await arrayBuffer(withLockfilesTarballPacker));
        withoutLockfilesTarball = Buffer.from(await arrayBuffer(withoutLockfilesTarballPacker));
    }
    // cold cache then warm cache
    for (const config of runners) {
        let runnerAPI;
        try {
            runnerAPI = await allocRunner(config);
        }
        catch (e) {
            yield {
                type: "diagnostic",
                message: `Failed to install ${config.name}`,
                cause: e,
            };
            continue;
        }
        for (const includeLockfiles of [false, true]) {
            // nicknames of cache scenarios
            // none - no node_modules, no global cache
            // warm - node_modules, global cache
            // warm-global - no node_modules, global cache
            // ??? TODO - node_modules, no global cache
            for (let cache of [
                { warmNodeModules: false, warmGlobalCache: false },
                { warmNodeModules: true, warmGlobalCache: true },
                { warmNodeModules: false, warmGlobalCache: true },
            ]) {
                let times = null;
                const results = {
                    // name: null,
                    versions: null,
                    dependencies: new Map(),
                };
                if (cache.warmNodeModules) {
                    await runnerAPI.rmLockfiles();
                }
                else {
                    await runnerAPI.rmNodeModulesAndLockfiles();
                }
                // ignore warmGlobalCache for now, TODO for ??? mode
                // reset files to original scenario
                await runnerAPI.injectManifestsAndLockfiles(includeLockfiles ? withLockfilesTarball : withoutLockfilesTarball);
                let testResult;
                try {
                    testResult = await runnerAPI.run();
                }
                catch (e) {
                    yield {
                        type: "diagnostic",
                        message: `${config.name} failed to install packages with config: ${JSON.stringify({
                            cache,
                            includeLockfiles,
                        })}`,
                        cause: e,
                    };
                    continue;
                }
                try {
                    await new Promise(async (fulfill, reject) => {
                        const extract = tar.extract();
                        extract.on("finish", () => fulfill());
                        extract.on("entry", async (headers, stream, next) => {
                            try {
                                if (headers.name === "output/packages.txt") {
                                    const lines = (await text(stream)).trim().split(/\r?\n/g);
                                    for (const line of lines) {
                                        const installation = JSON.parse(line);
                                        let node = results;
                                        for (const edgeName of installation.dependencyPath) {
                                            node.dependencies ??= new Map();
                                            node = emplace(node.dependencies, edgeName, {
                                                insert: () => {
                                                    return {
                                                        versions: null,
                                                        dependencies: null,
                                                    };
                                                },
                                            });
                                        }
                                        const versions = (node.versions ??= []);
                                        versions.push([
                                            { cache, includeLockfiles, name: config.name },
                                            installation.version,
                                        ]);
                                    }
                                }
                                else if (headers.name === "output/time.log") {
                                    const line = (await text(stream)).trim();
                                    // "%E,%S,%U,%M,%K,%w"
                                    const [elapsed_time, kernel_time, user_time, max_mem, avg_mem, waits,] = line.split(",");
                                    times = {
                                        elapsed_time,
                                        kernel_time,
                                        user_time,
                                        max_mem,
                                        avg_mem,
                                        // waits,
                                        // command: config.install_packages.trim(),
                                    };
                                }
                                else {
                                    await new Promise((fulfill, reject) => {
                                        stream.resume().on("end", fulfill).on("error", reject);
                                    });
                                }
                            }
                            catch (e) {
                                reject(e);
                            }
                            finally {
                                next();
                            }
                        });
                        extract.end(Buffer.from(testResult));
                    });
                }
                catch (e) {
                    console.error(e);
                }
                yield {
                    type: "result",
                    config: config.name,
                    includeLockfiles,
                    cache,
                    resource_usage: times,
                    results,
                };
            }
        }
        await runnerAPI.cleanup();
    }
}
//#region ARGV
const runners = [];
if (process.argv[3]) {
    const keys = process.argv[3].trim().split(/\s*,\s*/);
    for (const key of keys) {
        if (Object.hasOwn(allRunners, key)) {
            // @ts-ignore
            runners.push(allRunners[key]);
        }
    }
}
else {
    runners.push(...Object.values(allRunners));
}
let cwd = process.argv[2];
if (!cwd) {
    console.error(`
usage: run.mjs <cwd>

got argv: ${JSON.stringify(process.argv)}
  `.trim());
}
cwd = await fs.realpath(cwd);
//#endregion
async function main() {
    //   console.error("FINDING ALL MANIFESTS AND LOCKFILES IN:", cwd)
    const manifests = spawnSync("find", [
        ".",
        "-type",
        "f",
        "-a",
        "(",
        ...[...manifestFiles, ...lockfileFiles]
            .flatMap((name) => ["-o", "-name", name])
            .slice(1),
        ")",
        "!",
        "-path",
        "**/node_modules/**",
    ], {
        encoding: "utf-8",
        cwd,
        stdio: ["ignore", "pipe", "inherit"],
    });
    if (manifests.status !== 0) {
        console.error(manifests.stderr);
        throw new Error("error finding manifests");
    }
    const manifestPaths = manifests.stdout
        .trim()
        .split(/\r?\n/g)
        .filter((l) => l);
    if (manifestPaths.length === 0) {
        throw new Error("need manifests to compare, found none");
    }
    const entries = await Promise.all(manifestPaths.map(async (l) => {
        const resolved = join(cwd, l);
        return [l, await fs.readFile(resolved)];
    }));
    const files = new Map(entries);
    const elapsedTimes = new Map();
    const memoryAmounts = new Map();
    const diagnostic_table = [];
    const installs = [];
    for await (const entry of runSuite(files)) {
        if (entry.type === "diagnostic") {
            diagnostic_table.push([entry.message, entry.cause.message]);
        }
        else if (entry.type === "result") {
            const { resource_usage, config, cache, includeLockfiles, results } = entry;
            installs.push(results);
            if (resource_usage) {
                const timeSection = emplace(elapsedTimes, config, {
                    insert: () => []
                });
                const memorySection = emplace(memoryAmounts, config, {
                    insert: () => []
                });
                const timeParts = resource_usage['elapsed_time'].split(/:/g);
                let coefficient = 1000;
                let time = 0;
                while (timeParts.length) {
                    time += coefficient * parseFloat(timeParts.pop());
                    coefficient *= 60;
                }
                timeSection.push([
                    {
                        name: config,
                        cache,
                        includeLockfiles
                    },
                    Math.ceil(time)
                ]);
                console.log({ resource_usage }, timeSection.slice(-1)[0]);
                memorySection.push([
                    {
                        name: config,
                        cache,
                        includeLockfiles
                    },
                    Math.ceil(parseFloat(resource_usage['max_mem']))
                ]);
            }
        }
    }
    if (installs.length) {
        const pruned = prune(merge(installs));
        console.log(`## Differing Installs`);
        if (!pruned) {
            console.log(`No installs differed`);
        }
        else {
            let install_table_headers = ["config", "path", "version"];
            console.log(install_table_headers.join("|"));
            console.log(install_table_headers.map((_) => "----").join("|"));
            function flatten(installs, path = []) {
                const rows = [];
                if (installs.versions) {
                    for (const [config, version] of installs.versions) {
                        rows.push({
                            name: config.name,
                            includeLockfiles: config.includeLockfiles,
                            warmGlobalCache: config.cache.warmGlobalCache,
                            warmNodeModules: config.cache.warmNodeModules,
                            path: path.join("->"),
                            version: version ?? `(undefined)`,
                        });
                    }
                }
                if (installs.dependencies) {
                    for (const [depName, depInstall] of installs.dependencies) {
                        const newRows = flatten(depInstall, [...path, depName]);
                        rows.push(...newRows);
                    }
                }
                return rows;
            }
            let colors = [
                (s) => s,
                (s) => `\`${s}\``,
                (s) => `**${s}**`,
            ];
            console.log(flatten(pruned)
                .sort((a, b) => {
                if (a.path === b.path) {
                    return a.version <= b.version ? -1 : 1;
                }
                return a.path < b.path ? -1 : 1;
            })
                .reduce((groupedByPathAndVersion, row) => {
                let newGroup = false;
                if (groupedByPathAndVersion.length === 0) {
                    newGroup = true;
                }
                else {
                    let lastRow = groupedByPathAndVersion.slice(-1)[0];
                    if (row.path !== lastRow.path) {
                        newGroup = true;
                    }
                }
                if (newGroup) {
                    groupedByPathAndVersion.push({
                        path: row.path,
                        configs: [],
                    });
                }
                let lastRow = groupedByPathAndVersion.slice(-1)[0];
                lastRow.configs.push(row);
                return groupedByPathAndVersion;
            }, [])
                .map((row, i) => {
                // github doesn't let us zebra stripe markdown
                const colorFn = colors[i % colors.length];
                // pkg manager -> version -> configs
                const packageManagerDistinctVersions = partitionBy(row.configs, (config) => config.name, (config) => config.version);
                // version -> config summary
                const summaries = new Map();
                for (const [name, versions] of packageManagerDistinctVersions) {
                    const [singleVersionForName, version] = matchSinglePartition(versions);
                    if (singleVersionForName) {
                        const msg = `${name} (all variations)`;
                        emplace(summaries, version, {
                            insert: () => [],
                        }).push(msg);
                    }
                    else {
                        // includeLockfiles -> version -> configs
                        const distinctIncludeLockfiles = partitionBy(Array.from(versions.values()).flat(1), (config) => config.includeLockfiles, (config) => config.version);
                        for (const [value, versions] of distinctIncludeLockfiles) {
                            const [singleLockfilePartition, version] = matchSinglePartition(versions);
                            if (singleLockfilePartition) {
                                const msg = `${name} (includeLockfiles=${value})`;
                                emplace(summaries, version, {
                                    insert: () => [],
                                }).push(msg);
                            }
                            else {
                                // THIS IS VERY RARE AND LIKELY MEANS SOMETHING FISHY IS GOING ON
                                for (const [version, configs] of versions) {
                                    const existingSummaries = emplace(summaries, version, {
                                        insert: () => [],
                                    });
                                    for (const config of configs) {
                                        existingSummaries.push(`${name} (includeLockfiles=${value}, warmGlobalCache=${config.warmGlobalCache}, warmNodeModules=${config.warmNodeModules})`);
                                    }
                                }
                            }
                        }
                    }
                }
                return Array.from(summaries).map(([version, summaries]) => {
                    return [summaries.join("\n"), row.path, colorFn(version)]
                        .map(escapeNewlines)
                        .join("|");
                });
            })
                .flat(1)
                .join("\n"));
        }
    }
    if (elapsedTimes.size) {
        console.log("## Resource Usage");
        console.log('```mermaid');
        console.log(`
    gantt
    Title ${'Elapsed Time'}
    dateFormat  X
    axisFormat %s

    ${Array.from(elapsedTimes.entries(), ([section, rec]) => {
            return `section ${section}
          ${rec.map((r) => {
                return `lockfiles=${r[0].includeLockfiles} warmGlobalCache=${r[0].cache.warmGlobalCache} warmNodeModules=${r[0].cache.warmNodeModules}: 0, ${r[1]}`;
            }).join('\n')}
        `;
        }).join('\n')}
    `);
        console.log('```');
        console.log('```mermaid');
        console.log(`
    gantt
    Title ${'Max Memory Usage'}
    dateFormat  X
    axisFormat %s

    ${Array.from(memoryAmounts.entries(), ([section, rec]) => {
            return `section ${section}
          ${rec.map((r) => {
                return `lockfiles=${r[0].includeLockfiles} warmGlobalCache=${r[0].cache.warmGlobalCache} warmNodeModules=${r[0].cache.warmNodeModules}: 0, ${r[1]}`;
            }).join('\n')}
        `;
        }).join('\n')}
    `);
        console.log('```');
    }
    if (diagnostic_table.length) {
        let diagnostic_table_headers = ["message", "details"];
        console.log(`## Errors (${diagnostic_table.length})`);
        console.log(diagnostic_table_headers.join("|"));
        console.log(diagnostic_table_headers.map((_) => "----").join("|"));
        console.log(diagnostic_table
            .map((row) => row.map(escapeNewlines).join("|"))
            .join("\n"));
    }
}
main().catch((e) => {
    console.error(e);
    process.exit(1);
});
//#region utils
function escapeNewlines(cell) {
    return cell.replaceAll(/\r?\n/g, "<br>");
}
function merge(trees) {
    if (trees.length === 0)
        throw new Error("malformed merge, missing struct to merge");
    const versions = [];
    const depGroups = new Map();
    for (let i = 0; i < trees.length; i++) {
        const sub = trees[i];
        if (sub.versions) {
            versions?.push(...sub.versions);
        }
        if (sub.dependencies) {
            const subDeps = sub.dependencies;
            if (subDeps) {
                for (const [k, v] of subDeps) {
                    emplace(depGroups, k, {
                        insert: () => [],
                    }).push(v);
                }
            }
        }
    }
    const dependencies = new Map();
    for (const [edge, installs] of depGroups) {
        dependencies.set(edge, merge(installs));
    }
    return {
        versions: versions.length > 0 ? versions : null,
        dependencies: dependencies.size > 0 ? dependencies : null,
    };
}
/**
 * Prunes a tree in order to find difference points
 *
 * Given:
 * - NPM
 * /depends-on-foo@1.0.1
 * /depends-on-foo@1.0.1/foo@1.0.1
 * /bar@0.0.0/baz@0.0.0
 * - BUN
 * /depends-on-foo@1.0.0
 * /depends-on-foo@1.0.0/foo@1.0.1
 * /bar@0.0.0/baz@0.0.0
 * - DENO
 * /depends-on-foo@1.0.1
 * /depends-on-foo@1.0.1/foo@1.0.0
 *
 * It will only report:
 * - depends-on-foo (due to mismatch on bun vs npm/deno)
 * even though foo differs, it only differs after a divergent point in the module graph
 * @param tree
 * @returns
 */
function prune(tree) {
    // of the node has dependencies we have to prune them
    if (tree.dependencies) {
        const dependencies = tree.dependencies;
        for (const [key, subtree] of dependencies) {
            const prunedSubtree = prune(subtree);
            if (!prunedSubtree) {
                dependencies.delete(key);
                if (dependencies.size === 0) {
                    tree.dependencies = null;
                }
            }
        }
    }
    // all versions are the same, no need to report on it
    if (tree.versions && new Set(tree.versions.map((e) => e[1])).size === 1) {
        tree.versions = null;
    }
    // all dependency trees were pruned
    if (!tree.dependencies && !tree.versions) {
        return null;
    }
    return tree;
}
/**
 * Roughly same as TC39 Richer Keys Emplace proposal
 *
 * Does ~= `obj[k] ??= init()` style lazy init for a map
 */
function emplace(m, k, fns) {
    const existing = m.has(k);
    let ret;
    if (!existing) {
        if (fns.insert) {
            ret = fns.insert();
            m.set(k, ret);
        }
        else {
            throw new Error();
        }
    }
    else {
        ret = m.get(k);
        if (fns.update) {
            m.set(k, fns.update(ret));
        }
    }
    return ret;
}
function matchSinglePartition(partitioned) {
    if (partitioned.size === 1) {
        const [[key, values]] = partitioned;
        return [true, key, values];
    }
    return [false, null, Array.from(partitioned.values()).flat(1)];
}
//#endregion
