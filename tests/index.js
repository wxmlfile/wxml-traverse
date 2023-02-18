const fs = require('fs');
const path = require('path');
function test() {
    const files = fs.readdirSync(path.resolve(__dirname, './'));
    for (const file of files) {
        if (file !== 'index.js') {
            require(path.join(__dirname, file));
        }
    }
}

test();