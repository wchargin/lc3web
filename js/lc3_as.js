var assemble = (function() {

    /*
     * Splits a document string into lines,
     * and finds the whitespace-delimited portions of each line.
     * Quoting works, e.g.:
     *   '.STRINGZ "tokenize \"this\""'  --> ['.STRINGZ', 'tokenize "this"']
     * Returns an array of arrays.
     * That is, result[i][j] is the token j of line i.
     */
    var tokenize = function(text) {
        var result = [];
        var lines = text.split(/\r?\n/);
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i];
            var semicolon = line.indexOf(';');
            if (semicolon !== -1) {
                line = line.substring(0, semicolon);
            }
            // First, chomp all white space,
            // and consolidate comma groups: 'R1, R2, #1' -> 'R1,R2,#1'
            var squash = line.replace(/\s+/g, ' ');
            var commaSquash = squash.replace(/\s?,\s?/g, ',');
            // Then, split on whitespace, except for quoted strings.
            // Quote escaping with a backslash is considered.
            // From: http://stackoverflow.com/a/4032642/732016
            // Explanation:
            //   globally match
            //     groups of at least one okay character; or
            //     quotes around
            //       groups of at least one
            //         quote, preceded by (?:) a (literal) backslash, or
            //         non-quote character.
            // TODO: This might be buggy for strings like
            //   .STRINGZ "backslash quote \\"" (which should fail)
            var regex = /[A-Za-z0-9_#x,.-]+|"(?:\\"|[^"])+"/g;
            var tokens = commaSquash.match(regex);
            result.push(tokens || ''); // even if empty (keep line numbers)
        }
        return result;
    };


    // Returns either
    //   { error: <error message> } or
    //   { orig: <origin address>, begin: <index of line after .ORIG> }.
    var findOrig = function(tokenizedLines) {
        // Convenience function to generate an error object.
        var error = function(message) {
            return { error: message };
        }

        // Find the .ORIG directive.
        for (var i = 0; i < tokenizedLines.length; i++) {
            // Skip any blank or comment lines.
            var line = tokenizedLines[i];
            if (line.length === 0) {
                continue;
            }

            // Check if there's an .ORIG directive anywhere in the line.
            var hasOrig = false;
            for (var j = 0; j < line.length; j++) {
                if (line[j].toUpperCase() !== '.ORIG') {
                    hasOrig = true;
                    break;
                }
            }
            if (!hasOrig) {
                return error('First line must have .ORIG directive!');
            }

            // There's a directive somewhere.
            // If it's not the first, then there's a label. Not allowed.
            if (line[0].toUpperCase() !== '.ORIG') {
                return error('.ORIG directive cannot have a label!');
            }

            // If there's additional junk, that's not okay.
            // If there's no operand, that's not okay, either.
            if (line.length !== 2) {
                return error('.ORIG directive expects exactly one operand!');
            }

            // Well, there's something. Is it a number? Is it in range?
            orig = LC3Util.parseNumber(line[1]);
            if (orig === null) {
                return error('.ORIG operand must be a hex/decimal number!');
            }
            if (orig !== LC3Util.toUint16(orig)) {
                return error('.ORIG operand is out of range!');
            }

            // Looks like we're good.
            return { orig: orig, begin: i + 1 };
        }

        // If we get out of the loop, there were no non-empty lines.
        return error('File is empty!');
    };

    // Returns either
    //   { error: <list of error messages> } or
    //   { symbols: <symbol table> }
    var generateSymbolTable = function(tokenizedLines, orig, begin) {
        var symbols = { }; // maps labels to page addresses
        var errors = [];

        var pageAddress = orig;

        // Convenience function to generate an error object.
        var error = function(lineIndex, message) {
            errors.push('line ' + (lineIndex + 1) + ': ' + message);
        }

        // Determines whether a potential label name is valid (alphabetic).
        var labelNameOkay = function(label) {
            return !label.match(/[^A-Za-z_]/);
        };

        // These are all the instructions that take no operands.
        // Note that the only nullary assembly directive is .END.
        // This is not included in this list; it's handled separately.
        var nullaries = 'RET RTI GETC OUT PUTS IN PUTSP HALT'.split(' ');

        // Gets the length (in words) of the given instruction or directive.
        var lengthOf = function(command, operand) {
            command = command.toUpperCase();
            if (command === '.FILL') {
                return 1;
            } else if (command === '.BLKW') {
                var count = LC3Util.parseNumber(operand);
                return count === LC3Util.toUint16(count) ? count : null;
            } else if (command === '.STRINGZ') {
                // Get the inside of the string.
                var contents = operand.substring(1, operand.length - 1);
                // Match characters, counting backslash-escapes as one.
                // Add one for the null-terminator.
                return contents.match(/[^\\"]|\\[\\"0nr]/g).length + 1;
            } else {
                // It must be a regular instruction, not a directive.
                return 1;
            }
        };

        for (var i = begin; i < tokenizedLines.length; i++) {
            var line = tokenizedLines[i];
            var length = line.length;
            if (length === 0) {
                continue;
            }
            // First, check if we're done.
            var hasEnd = false;
            for (var j = 0; j < length; j++) {
                if (line[j].toUpperCase() === '.END') {
                    hasEnd = true;
                    break;
                }
            }
            if (hasEnd) {
                break;
            }
            // If the line's not blank, and it's not an .END,
            // then we had better be within memory bounds.
            if (pageAddress >= 0x10000) {
                error('Outside maximum memory address! Aborting.');
                break;
            }
            // Otherwise, let's take a look at the data.
            if (length === 1) {
                var data = line[0];
                // This could be a line with a nullary instruction,
                // like RET, HALT, etc.
                if (nullaries.indexOf(data.toUpperCase()) !== -1) {
                    // No problem here.
                    // None of these is an assembly directive,
                    // so we'll increment the page address by exactly one.
                    pageAddress++;
                    // There's also no label here, so there's nothing to do.
                    continue;
                }
                // No instruction. This is a label-only line.
                var label = line[0];
                if (!labelNameOkay(label)) {
                    error(i, 'Label name invalid (must be alphabetic only)!');
                } else if (label in symbols) {
                    error(i, 'Label name "' + label + '" already exists!');
                } else {
                    // We're okay.
                    // Add the label, but don't increment the page address.
                    symbols[label] = pageAddress;
                }
            } else if (length === 2) {
                // This could be an operation and its operands,
                // or a label and a nullary operation.
                var fst = line[0], snd = line[1];
                if (nullaries.indexOf(snd) !== -1) {
                    // Label and nullary instruction.
                    symbols[fst] = pageAddress;
                    pageAddress++;
                } else {
                    // Instruction and operands.
                    // No label to set, but we should advance the page.
                    pageAddress += lengthOf(line[0], line[1]);
                }
            } else if (length === 3) {
                // This is a label, an instruction, and its operands.
                symbols[line[0]] = pageAddress;
                pageAddress += lengthOf(line[1], line[2]);
            } else {
                // Uh, that shouldn't be.
                error(i, 'Too many tokens! I give up.');
            }
        }
        return errors.length ? { error: errors } : { symbols: symbols };
    };

    // Returns either:
    //   { error: <list of errors> } or
    //   { code: <list of machine code words, as numbers> }
    var generateMachineCode = function(tokens, orig, begin, symbols) {
        return { error: 'Machine code generation not implemented!' };
    };

    // Actual assembly function (combine the above steps)
    return function(fileContents) {
        // Tokenize the document.
        var tokens = tokenize(fileContents);

        // Find the origin.
        var origData = findOrig(tokens);
        if (origData.error) {
            return origData;
        }
        var orig = origData.orig;
        var begin = origData.begin;

        // Create the symbol table.
        var symbolTable = generateSymbolTable(tokens, orig, begin);
        if (symbolTable.error) {
            return symbolTable;
        }
        var symbols = symbolTable.symbols;

        // Generate the machine code.
        var mc = generateMachineCode(tokens, orig, begin, symbols);
        if (mc.error) {
            return mc;
        }

        // Package and return the result.
        var result = {
            orig: orig,
            machineCode: mc.code,
            symbolTable: symbols,
        };
        return result;
    };
})();
