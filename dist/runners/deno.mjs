export const config = {
    name: 'Deno',
    description: 'Run deno with customized deps.ts from package.json',
    install_pkg_manager: `
        curl -fsSL https://deno.land/x/install/install.sh | sh
    `,
    install_packages: `
        node -e 'fs.writeFileSync("deps.ts", Object.entries(require("./package.json").dependencies ?? {}).map((e)=>"import \\"npm:"+e[0]+"@"+e[1]+"\\"").join("\\n"))'
        /root/.deno/bin/deno run deps.ts
    `
};
