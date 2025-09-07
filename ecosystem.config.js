module.exports = {
  apps: [
    {
      name: 'baiyin-hcm',
      script: './node_modules/.bin/tsx',
      args: 'index.tsx',
      interpreter: 'node',
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
