window.LC3Util = {

    /*
     * Parses a decimal or hexadecimal value, or returns NaN.
     */
    parseNumber: function(value) {
        value = value.toLowerCase();
        if (value.length == 0) {
            return NaN;
        }
        var negative = false;
        if (value[0] === '-') {
            value = value.slice(1);
            negative = true;
        }
        switch (value[0]) {
            // Hex: input is like "x123"
            case 'x':
                var hexDigits = value.slice(1);
                if (hexDigits.match(/[^0-9a-f]/)) {
                    return NaN;
                }
                var num = parseInt(hexDigits, 16);
                return negative ? -num : num;
            // Binary: input is like "b1101"
            case 'b':
                var binaryDigits = value.slice(1);
                if (binaryDigits.match(/[^01]/)) {
                    return NaN;
                }
                var num = parseInt(binaryDigits, 2);
                return negative ? -num : num;
            // Decimal: input is like "1234"
            default:
                if (value.match(/[^0-9]/)) {
                    return NaN;
                }
                var num = parseInt(value);
                return negative ? -num : num;
        }
    },

    /*
     * Converts a number to a four-digit hexadecimal string with 'x' prefix.
     */
    toHexString: function(value, padLength) {
        var hex = value.toString(16).toUpperCase();
        padLength = padLength || 4;
        if (hex.length < padLength) {
            hex = (Array(padLength - hex.length + 1).join('0')) + hex;
        }
        return 'x' + hex;
    },

    /*
     * Converts a number possibly outside the [-32768, 32767] range
     * to a 16-bit signed integer.
     */
    toInt16: function(n) {
        n = (n % 0x10000) & 0xFFFF;
        if (n & 0x8000) {
            return n - 0x10000;
        }
        return n;
    },

    toUint16: function(n) {
        var int16 = this.toInt16(n);
        return int16 < 0 ? int16 + 0x10000 : int16;
    },

    /*
     * Sign-extends a size-bit number n to 16 bits.
     */
    signExtend16: function(n, size) {
        var sign = (n >> (size - 1)) & 1;
        if (sign === 1) {
            for (var i = size; i < 16; i++) {
                n |= (1 << i);
            }
        } else {
            n &= (1 << size) - 1;
        }
        return this.toInt16(n);
    },
};
