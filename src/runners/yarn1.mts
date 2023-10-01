import type { TestConfig } from '../template.mjs'

export const config = {
    name: 'Yarn1',
    description: 'Run yarn in classic mode',
    install_pkg_manager: `
        npm -g install yarn -f
    `,
    install_packages: `
        yarn install
    `
} as const satisfies TestConfig
