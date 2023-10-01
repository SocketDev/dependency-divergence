export const config = {
    name: 'PNPM',
    description: 'Run pnpm',
    install_pkg_manager: `
        npm -g install pnpm -f
    `,
    install_packages: `
        pnpm install
    `
};
