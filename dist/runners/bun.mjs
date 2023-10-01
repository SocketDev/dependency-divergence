export const config = {
    name: 'Bun',
    description: 'Run bun',
    install_pkg_manager: `
        curl -fsSL https://bun.sh/install | bash
    `,
    install_packages: `
        /root/.bun/bin/bun install
    `
};
