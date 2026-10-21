'use strict';
// Synthetic fixture source for the assess tests.
const { price } = require('./pricing');

module.exports = { total: (items) => items.reduce((a, i) => a + price(i.cents), 0) };
