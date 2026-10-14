const path = require('path');
const fs = require('fs');
const webpack = require('webpack');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const CopyWebpackPlugin = require('copy-webpack-plugin');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');

const SRC = path.resolve(__dirname, 'src');

/**
 * 导出的离线报告必须自带 diff 算法和解压库，且不能依赖任何 CDN。
 * 这三段源码在构建期以字符串常量注入，只有报告生成器（懒加载分片）会用到，
 * 因此不会拖累主包体积。
 *
 * 用 DefinePlugin 而不是 raw-loader：后者会和 babel-loader 在同一个请求上叠加，
 * 在 webpack 4 上的 loader 顺序行为不够直观，编译期常量更省事也更可控。
 */
const readInline = (rel) => fs.readFileSync(path.resolve(__dirname, rel), 'utf8');

module.exports = (env, argv) => {
  const isProd = argv && argv.mode === 'production';

  return {
    entry: path.join(SRC, 'index.jsx'),

    output: {
      path: path.resolve(__dirname, 'dist'),
      filename: isProd ? 'static/js/[name].[contenthash:8].js' : 'static/js/[name].js',
      publicPath: '/'
    },

    //. webpack4 内置的 acorn 解析不了可选链 / 空值合并。antd、rc-* 等包的 ESM 产物
    //. 里普遍带这些语法，一旦 webpack 优先解析到 module 字段就会直接编译失败。
    //. 这里把 main 提到 module 前面，强制走各包已经转译成 ES5 的 CommonJS 产物。
    resolve: {
      extensions: ['.js', '.jsx', '.json'],
      mainFields: ['browser', 'main', 'module'],
      alias: {
        '@': SRC
      }
    },

    module: {
      rules: [
        {
          test: /\.jsx?$/,
          include: SRC,
          use: [{ loader: 'babel-loader', options: { cacheDirectory: true } }]
        },
        {
          test: /\.css$/,
          use: [
            isProd ? MiniCssExtractPlugin.loader : 'style-loader',
            { loader: 'css-loader', options: { importLoaders: 1 } }
          ]
        },
        {
          test: /\.less$/,
          use: [
            isProd ? MiniCssExtractPlugin.loader : 'style-loader',
            { loader: 'css-loader', options: { importLoaders: 2, sourceMap: !isProd } },
            { loader: 'less-loader', options: { javascriptEnabled: true, sourceMap: !isProd } }
          ]
        },
        {
          test: /\.(png|jpe?g|gif|svg)$/i,
          loader: 'file-loader',
          options: { name: 'static/media/[name].[hash:8].[ext]' }
        },
        {
          test: /\.(woff2?|eot|ttf|otf)$/i,
          loader: 'file-loader',
          options: { name: 'static/fonts/[name].[hash:8].[ext]' }
        }
      ]
    },

    plugins: [
      new webpack.DefinePlugin({
        __VENDOR_DIFF_JS__: JSON.stringify(readInline('node_modules/diff/dist/diff.min.js')),
        __VENDOR_LZSTRING_JS__: JSON.stringify(readInline('node_modules/lz-string/libs/lz-string.min.js')),
        __SRC_DIFF_ENGINE_JS__: JSON.stringify(readInline('src/core/diffEngine.js'))
      }),

      new HtmlWebpackPlugin({
        template: path.resolve(__dirname, 'public/index.html'),
        filename: 'index.html',
        inject: 'body',
        minify: isProd ? { collapseWhitespace: true, removeComments: false } : false
      }),

      //. Monaco 以静态资源形式随包发布，运行时用 AMD loader 从同源目录加载。
      //. 这样既不打进 bundle，也不依赖任何外部 / 内网 CDN —— 部署时把 dist 整个拷走即可离线运行。
      new CopyWebpackPlugin([
        {
          from: path.resolve(__dirname, 'node_modules/monaco-editor/min/vs'),
          to: path.resolve(__dirname, 'dist/monaco/vs'),
          ignore: ['*.map']
        }
      ])
    ].concat(
      isProd
        ? [new MiniCssExtractPlugin({ filename: 'static/css/[name].[contenthash:8].css' })]
        : []
    ),

    optimization: {
      splitChunks: {
        cacheGroups: {
          vendor: {
            test: /[\\/]node_modules[\\/]/,
            name: 'vendor',
            chunks: 'all',
            priority: 10
          }
        }
      }
    },

    devtool: isProd ? false : 'cheap-module-eval-source-map',

    performance: { hints: false },

    stats: 'minimal',

    devServer: {
      host: '0.0.0.0',
      port: 8125,
      contentBase: path.resolve(__dirname, 'dist'),
      historyApiFallback: true,
      hot: false,
      liveReload: true,
      compress: false,
      overlay: { warnings: false, errors: true },
      stats: 'minimal',
      //. node12 时代的 chokidar 在部分文件系统上会打满 CPU，关掉轮询
      watchOptions: { poll: false, ignored: /node_modules/ }
    }
  };
};
