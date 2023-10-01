export const config = {
    name: 'Yarn3 (berry)',
    description: 'Run yarn berry in a node_modules linker mode',
    install_pkg_manager: `
        npm -g install yarn -f
        yarn set version berry
        echo 'nodeLinker: node-modules' > .yarnrc.yml
    `,
    install_packages: `
        yarn install
    `
};
