export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'scope-empty': [2, 'never'],
    'scope-delimiter-style': [2, 'always', [',']],
  },
};
