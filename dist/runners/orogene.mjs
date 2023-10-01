export const config = {
    name: 'Orogene',
    description: 'Run orogene',
    install_pkg_manager: `
        npm install -g oro -f
    `,
    install_packages: `
        oro apply
    `
};
