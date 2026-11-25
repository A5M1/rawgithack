import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

export default (env, argv) => {
  const isProduction = argv.mode === 'production';

  return {
    mode: isProduction ? 'production' : 'development',
    entry: {
      dashboard: path.join(root, 'src/client/dashboard.js'),
      'recovery-codes': path.join(root, 'src/client/recovery-codes.js'),
    },
    output: {
      path: path.join(root, 'web/dist'),
      filename: '[name].js',
      clean: true,
    },
    // Production bundles must not ship source maps.
    devtool: isProduction ? false : 'eval-cheap-module-source-map',
    optimization: {
      minimize: isProduction,
    },
    performance: {
      hints: false,
    },
  };
};
