import child_process, { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { text, arrayBuffer } from "node:stream/consumers";
export const manifestFiles = new Set([
    ".npmrc",
    ".yarnrc.yaml",
    ".yarnrc.yml",
    "pnpm-workspace.yaml",
    "pnpm-workspace.yml",
    "package.json",
]);
export const lockfileFiles = new Set([
    "package-lock.json",
    "pnpm-lock.yaml",
    "pnpm-lock.yml",
    "yarn.lock",
    "npm-shrinkwrap.json",
    "bun.lockb",
]);
let $rootImg;
const rootImg = async () => {
    return ($rootImg ??= await (async () => {
        const imgResult = child_process.spawn("docker", ["build", "--quiet", fileURLToPath(new URL("../", import.meta.url))], {
            stdio: "pipe",
        });
        const imgIdProm = text(imgResult.stdout);
        await checkStatus(imgResult, "build container");
        const imgId = (await imgIdProm).trim();
        console.error("root image", imgId);
        return imgId;
    })());
};
// install_pkg_manager => imgid
const committedImages = new Map();
process.on("exit", () => {
    for (const imgid of committedImages.values()) {
        spawnSync("docker", ["rmi", "--force", imgid]);
    }
});
// TODO: hook this up for more robust details
// const preamble = `
// function stdio_file () {
//     # close stdio file descriptors
//     exec 1<&-
//     exec 2<&-
//     # Open standard output as $LOG_FILE file for read and write.
//     exec 1<>$1
//     exec 2>&1
// }
// # stdio_file /opt/output/bootstrap.log
// set -e
// ` as const
async function getContainerForImage(imgId, info = "run container") {
    const containerResult = child_process.spawn("docker", ["run", "--rm", "--detach", imgId, "sleep", "infinity"], {
        stdio: "pipe",
    });
    const containerId = (await text(containerResult.stdout)).trim();
    console.error(info, containerId);
    await checkStatus(containerResult, info);
    function cleanup() {
        process.off("exit", cleanup);
        // return
        child_process.spawnSync("docker", ["rm", "--force", containerId], {
            stdio: "ignore",
            encoding: "utf-8",
        });
    }
    process.on("exit", cleanup);
    return { containerId, cleanup };
}
async function getCommitedImageForInstallPkgManager(install_pkg_manager, name) {
    {
        const existing = committedImages.get(install_pkg_manager);
        if (existing)
            return existing;
    }
    const { containerId, cleanup } = await getContainerForImage(await rootImg(), `build install_pkg_manager container for ${name}`);
    try {
        const install_pkg_manager_pid = child_process.spawn("docker", [
            "exec",
            "--env",
            `install_pkg_manager=${install_pkg_manager}`,
            containerId,
            "bash",
            "-e",
            "-c",
            `
        cd /root/
        sh -e -c "$install_pkg_manager"
        `,
        ], {
            stdio: "pipe",
        });
        await checkStatus(install_pkg_manager_pid, "install " + name);
        const containerResult = child_process.spawn("docker", ["commit", containerId], {
            stdio: "pipe",
        });
        const imgIdProm = text(containerResult.stdout);
        await checkStatus(containerResult, "snapshot install of " + name);
        const imgId = (await imgIdProm).trim();
        committedImages.set(install_pkg_manager, imgId);
        return imgId;
    }
    finally {
        cleanup();
    }
}
async function checkStatus(child, name) {
    if (child.exitCode != null) {
        throw new Error("CHILD " + name + " already exited with " + child.exitCode);
    }
    const stderr = child.stderr ? text(child.stderr) : Promise.resolve("");
    const stdout = child.stdout ? text(child.stdout) : Promise.resolve("");
    return new Promise((fulfill, reject) => {
        child.on("error", reject).on("exit", async (status, signal) => {
            if (status !== 0 || signal) {
                let details = '';
                const stderrStr = await stderr;
                const stdoutStr = await stdout;
                if (stderrStr) {
                    details += `STDERR:\n${stderrStr}\n`;
                }
                if (stdoutStr) {
                    details += `STDOUT:\n${stdoutStr}\n`;
                }
                if (details) {
                    details = `\n${details}`;
                }
                const child = name ? JSON.stringify(name) : "child";
                reject(new Error(signal
                    ? `${child} exited with signal: ${signal}${details}`
                    : `${child} exited with non-0 status: ${status}${details}`));
            }
            else {
                fulfill();
            }
        });
    });
}
export async function allocRunner({ name, description, install_pkg_manager, install_packages }) {
    const img = await getCommitedImageForInstallPkgManager(install_pkg_manager, name);
    //#region spawning docker
    const { containerId, cleanup } = await getContainerForImage(img, `build install_packages container for ${name}`);
    return {
        cleanup,
        async injectManifestsAndLockfiles(inputTar) {
            try {
                const cp = child_process.spawn("docker", ["cp", "-", `${containerId}:/root/`], {
                    stdio: "pipe",
                });
                cp.stdin.end(inputTar);
                await checkStatus(cp, "copy package.json into container");
            }
            catch (e) {
                throw e;
            }
        },
        async run() {
            const install = child_process.spawn("docker", [
                "exec",
                "--env",
                `install_packages=${install_packages}`,
                containerId,
                "bash",
                "-e",
                "-c",
                `
          /usr/bin/time --format="%E,%S,%U,%M,%K,%w" -o /opt/output/time.log sh -e -c "$install_packages"

          node /opt/scripts/dump-declared-pkg-tree.mjs > /opt/output/packages.txt
          `,
            ], {
                stdio: "pipe",
            });
            // console.log('STARTED', {install_packages})
            await checkStatus(install, "run install");
            const out = child_process.spawn("docker", ["cp", `${containerId}:/opt/output/`, "-"], {
                stdio: "pipe",
            });
            const stdout = arrayBuffer(out.stdout);
            await checkStatus(out, "copy output out of container");
            return await stdout;
        },
        async rmLockfiles() {
            const rm = child_process.spawn("docker", [
                "exec",
                containerId,
                "bash",
                "-e",
                "-c",
                `
              find ${[
                    ".",
                    "-type",
                    "f",
                    "-a",
                    "\\(",
                    ...[...lockfileFiles].flatMap((name) => ["-o", "-name", name]).slice(1),
                    "\\)",
                    "\\!",
                    "-path",
                    "\\*\\*/node_modules/\\*\\*",
                    "-a",
                ].join(' ')} | xargs -n1 -I{} rm {}
              `
            ], {
                stdio: "pipe",
            });
            await checkStatus(rm, "run rmLockfiles");
        },
        async rmNodeModulesAndLockfiles() {
            const rm = child_process.spawn("docker", [
                "exec",
                containerId,
                "bash",
                "-e",
                "-c",
                `
            rm -rf node_modules
            rm -rf /root/.deno/cache
            rm -rf ~/.bun/install/cache
            `
            ], {
                stdio: "pipe",
            });
            await checkStatus(rm, "run rmNodeModulesAndLockfiles");
            await this.rmLockfiles();
        }
    };
}
