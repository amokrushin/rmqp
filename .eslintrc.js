module.exports = {
    extends: 'airbnb',
    rules: {
        'consistent-return': ['off'],
        /* Do not ensure an imported module can be resolved to a module on the local filesystem */
        'import/no-unresolved': 'off',
        /* Set 2-space indentation, opposite of default 2 */
        'indent': ['error', 4, {
            /* Enforce indentation level for case clauses in switch statements */
            'SwitchCase': 1,
        }],
        'max-len': ['error', { 'code': 120 }],
        /* Allow reassignment of function parameters */
        'no-param-reassign': ['off'],
        /* Allow unary operators ++ and -- */
        'no-plusplus': ['off'],
        /* Allow dangling underscores in identifiers */
        'no-underscore-dangle': ['off'],
    },
    env: {
        node: true,
    },
    root: true,
};
