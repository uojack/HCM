module.exports = {
  apps: [
    {
      name: 'baiyin-hcm',
      script: './node_modules/tsx/dist/cli.mjs',
      args: 'index.tsx',
      interpreter: 'node',
      node_args: ['--experimental-modules'],
      watch: false,
      env: {
        PORT: '3000',
        DATA_DIR: './data',
        WECOM_DEV_ALLOW_FALLBACK: '1',
        BASE_URL: 'http://localhost:3000'
      }
    }
  ]
};
