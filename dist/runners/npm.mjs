export const config = {
    name: 'NPM',
    description: 'Run npm',
    install_pkg_manager: `
        npm -g install npm -f
    `,
    install_packages: `
        npm install
    `
};
