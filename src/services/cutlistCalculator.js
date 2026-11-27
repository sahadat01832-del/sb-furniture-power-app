// The cut-list calculator lives under public/js so the API server and both
// admin frontends run the same packing code. Keep this file as the server entry
// point (aiRouter and the tests import it), not a second implementation.
module.exports = require('../../public/js/cutlist-calculator');
