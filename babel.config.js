module.exports = {
  presets: [
    ['@babel/preset-env', {
      //. 内网环境浏览器版本不可控，编译到 ES5 最稳
      targets: { browsers: ['last 2 Chrome versions', 'last 2 Firefox versions', 'ie 11'] },
      useBuiltIns: false,
      modules: false
    }],
    ['@babel/preset-react', { development: false }]
  ],
  plugins: [
    '@babel/plugin-proposal-class-properties',
    '@babel/plugin-proposal-optional-chaining',
    '@babel/plugin-proposal-nullish-coalescing-operator'
  ]
};
