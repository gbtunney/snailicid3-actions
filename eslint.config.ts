import {
    EsLint,
    expandExtensions,
    TS_FILE_EXTENSIONS,
} from '@snailicid3/config'

import url from 'node:url'

const __dirname = url.fileURLToPath(new URL('.', import.meta.url))

const CONFIG = EsLint.config(__dirname)

export default EsLint.defineConfig([
    ...CONFIG,

    {
        files: expandExtensions(TS_FILE_EXTENSIONS, '**/src/**/*'),

        name: 'Naming: allow ids for paramaters',

        rules: {
            '@typescript-eslint/naming-convention': [
                'error',

                {
                    custom: {
                        match: true,

                        regex: '^([a-zA-Z][a-zA-Z0-9_]{2,}|id|db|fs|ctx|req|res)$',
                    },

                    format: ['camelCase'],

                    selector: 'parameter',
                },
            ],
        },
    },

])
