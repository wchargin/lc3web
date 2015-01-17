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
            return { error: [message] };
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
    //   { symbols: <symbol table>, length: <number of words> }
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
                if (nullaries.indexOf(snd.toUpperCase()) !== -1) {
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
            // Make sure this wasn't, e.g., a .BLKW on the edge of memory.
            if (pageAddress > 0x10000) {
                error('Outside maximum memory address! Aborting.');
                break;
            }
        }

        // Package result and return.
        if (errors.length > 0) {
            return { error: errors };
        } else {
            return { symbols: symbols, length: pageAddress - orig };
        }
    };

    // Returns either:
    //   { error: <list of errors> } or
    //   { code: <list of machine code words, as numbers> }
    var generateMachineCode = function(lines, orig, begin, length, symbols) {
        var mc = new Array(length);
        var errors = [];

        var pageAddress = orig;

        // Convenience function to generate an error object.
        var error = function(lineIndex, message) {
            errors.push('line ' + (lineIndex + 1) + ': ' + message);
        }
        // Error generator for an invalid number of operands.
        var errorOpcount = function(lineIndex, expected, actual) {
            var e = expected + ' ' + (expected === 1 ? 'operand' : 'operands');
            error(lineIndex, 'Expected ' + e + ', but found ' + actual + '!');
        };

        // These are all the instructions that take no operands.
        // Note that the only nullary assembly directive is .END.
        // This is not included in this list; it's handled separately.
        // Each nullary instruction should map to exactly one word.
        var nullaries = {
            'RET':   0xC1C0,
            'RTI':   0x8000,
            'GETC':  0xF020,
            'OUT':   0xF021,
            'PUTS':  0xF022,
            'IN':    0xF023,
            'PUTSP': 0xF024,
            'HALT':  0xF025
        };

        // Validates a minimum and maximum range, inclusive.
        // Returns a boolean.
        var inRange = function(x, min, max) {
            return min <= x && x <= max;
        };
        var inBitRangeSigned = function(x, bits) {
            var min = -(1 << (bits - 1));
            var max = (1 << (bits - 1)) - 1;
            return inRange(x, min, max);
        };

        // Determines the specified register, or returns an error.
        // Example: "R3" -> 3, "R" -> '<error text>'
        var parseRegister = function(op) {
            var cop = op.toUpperCase();
            if (cop.charAt(0) !== 'R') {
                return 'Expected register name; found "' + op + '"!';
            } else if (cop.length === 1) {
                return 'No register name provided!';
            } else if (cop.length > 2) {
                return 'Register names should be a single digit!';
            } else {
                var register = parseInt(op.substring(1));
                if (isNaN(register) || register < 0 || register > 7) {
                    return 'No such register "' + op + '"!';
                } else {
                    // Everything checks out.
                    return register;
                }
            }
        };

        // Determines the specified literal, or returns an error.
        // No range checking or coercing (e.g., toUint16) is performed.
        // Examples: "#7" -> 7, "-xBAD" -> -0xBAD, "label" -> '<error text>'
        var parseLiteral = function(literal) {
            var src = literal;
            var negate = false;
            var first = src.charAt(0);
            if (first === '-') {
                negate = true;
                src = src.substring(1);
                first = src.charAt(0);
            }
            if (first === '#' || first.toLowerCase() === 'x') {
                // Standard decimal or hexadecimal literal.
                var num;
                var invalid;
                if (first === '#') {
                    num = LC3Util.parseNumber(src.substring(1));
                    invalid = 'Invalid decimal literal!';
                } else {
                    num = LC3Util.parseNumber(src);
                    invalid = 'Invalid hexadecimal literal!';
                }
                if (isNaN(num)) {
                    return invalid;
                }
                if (negate && num < 0) {
                    // No double negatives.
                    // (I tried a pun, but they were just too bad.)
                    return invalid;
                }
                return negate ? -num : num;
            } else {
                return 'Invalid literal!';
            }
        };

        // Parses a PC-relative offset, in either literal or label form.
        // The resulting offset must fit in the given number of bits.
        // Returns the offset from the current PC (as unsigned),
        // or an error message if failed.
        var parseRelativeAddress = function(pc, operand, bits) {
            var offset;
            var literal = parseLiteral(operand);
            if (!isNaN(literal)) {
                // Literal offset.
                offset = literal;
            } else {
                // Label offset.
                offset = symbols[operand] - pc;
                if (isNaN(offset)) {
                    return 'No such label "' + operand + '"!';
                }
            }
            // Check that offset fits in the bits.
            if (inBitRangeSigned(offset, bits)) {
                return LC3Util.toUint16(offset) & ((1 << bits) - 1);
            } else {
                return 'Offset is out of range!';
            }
        };

        // Parses the given command and operand.
        // If valid, sets memory accordingly and advances the page address.
        // Otherwise, adds an error to the list of errors.
        // This method returns nothing.
        var applyInstruction = function(l, command, operand) {
            // Standardize case for ease of comparison.
            command = command.toUpperCase();
            // Find where we'll insert the command.
            var index = pageAddress - orig;
            // Logic time!
            if (command.charAt(0) === '.') {
                // Assembly directive.
                if (command === '.FILL') {
                    // The operand could be either a literal or a label.
                    var num = LC3Util.parseNumber(operand);
                    if (!isNaN(num)) {
                        // It's a literal.
                        mc[index] = LC3Util.toUint16(num);
                        pageAddress++;
                        return;
                    } else {
                        // It's a label (or it should be).
                        var address = symbols[operand];
                        if (address !== undefined) {
                            mc[index] = address;
                            pageAddress++;
                        } else {
                            error(l, 'No such label "' + operand + '"!');
                            return;
                        }
                    }
                } else if (command === '.BLKW') {
                    // The operand should be a non-negative integer.
                    var length = LC3Util.parseNumber(operand);
                    if (isNaN(length)) {
                        error(l, 'Operand to .BLKW is not a number!');
                        return;
                    } else if (length < 0) {
                        error(l, 'Operand to .BLKW must be positive!');
                        return;
                    } else {
                        for (var i = 0; i < length; i++) {
                            mc[index] = 0x00;
                            pageAddress++;
                            index++;
                        }
                        return;
                    }
                } else if (command === '.STRINGZ') {
                    // Warning: arduous string parsing and validation ahead.
                    // First, make sure it's even a string.
                    if (operand.charAt(0) !== '"') {
                        error(l, 'Operand to .STRINGZ must be a string!');
                        return;
                    }
                    // Validate each character and add it.
                    // (Don't include the quote delimiters, obviously.)
                    var i;
                    for (i = 1; i < operand.length - 1; i++) {
                        var c = operand.charAt(i);
                        if (c === '\\') {
                            // Supported escape sequences: \0, \n, \r, \", \\.
                            i++;
                            var cn = operand.charAt(i);
                            var escaped = null;
                            if (cn === '0') {
                                escaped = '\0';
                            } else if (cn === 'n') {
                                escaped = '\n';
                            } else if (cn === 'r') {
                                escaped = '\r';
                            } else if (cn === '"') {
                                escaped = '\"';
                            } else if (cn === '\\') {
                                escaped = '\\';
                            }
                            if (escaped !== null) {
                                mc[index] = escaped.charCodeAt(0) & 0xFF;
                                index++;
                                pageAddress++;
                                continue;
                            } else {
                                error(l, 'Invalid escape "\\' + cn + '"!');
                                return;
                            }
                        } else if (c === '"') {
                            // That's an unescaped quote, and we're not done.
                            error(l, 'Unescaped quote before end of string!');
                            return;
                        } else {
                            mc[index] = c.charCodeAt(0) & 0xFF;
                            index++;
                            pageAddress++;
                            continue;
                        }
                    }
                    // Make sure we didn't backslash-escape the closing quote.
                    if (i >= operand.length || operand[i] !== '"') {
                        error(l, 'Unterminated string literal!');
                        return;
                    }
                    // Add the null terminator.
                    mc[index] = 0x00;
                    index++;
                    pageAddress++;
                } else {
                    // The command starts with a dot,
                    // but is not .FILL, .BLKW, or .STRINGZ.
                    error(l, 'Invalid directive "' + command + '"!');
                    return;
                }
            } else {
                // It's an instruction, not a directive.
                var opcode = {
                    'ADD':   1,
                    'AND':   5,
                    'BR':    0,
                    'BRN':   0,
                    'BRZ':   0,
                    'BRNZ':  0,
                    'BRP':   0,
                    'BRNP':  0,
                    'BRZP':  0,
                    'BRNZP': 0,
                    'JMP':   12,
                    'JSR':   4,
                    'LD':    2,
                    'LDR':   6,
                    'LDI':   10,
                    'LEA':   14,
                    'NOT':   9,
                    'RET':   12,
                    'RTI':   8,
                    'ST':    3,
                    'STR':   7,
                    'STI':   11,
                    'TRAP':  15,
                }[command];
                if (opcode === undefined) {
                    error(l, 'Unrecognized instruction "' + command + '"!');
                    return;
                }
                // When executed, the PC will be one past the current address.
                var pc = pageAddress + 1;
                // Create the instruction as an integer. Start with opcode.
                var instruction = opcode << 12;
                var operands = operand.split(',');
                var opcount = operands.length;
                // Process each opcode.
                if (command === 'ADD' || command === 'AND') {
                    if (opcount !== 3) {
                        errorOpcount(l, 3, opcount);
                        return;
                    }
                    var dr = parseRegister(operands[0]);
                    var sr1 = parseRegister(operands[1]);
                    if (isNaN(dr)) {
                        error(l, dr);
                        return;
                    }
                    if (isNaN(sr1)) {
                        error(l, sr1);
                        return;
                    }
                    instruction |= (dr << 9);
                    instruction |= (sr1 << 6);
                    var sr2 = parseRegister(operands[2]);
                    if (!isNaN(sr2)) {
                        // Register mode.
                        instruction |= sr2;
                    } else {
                        // Immediate mode.
                        var immediate = parseLiteral(operands[2]);
                        if (isNaN(immediate)) {
                            error(l, 'Operand neither register nor literal!');
                            return;
                        }
                        if (!inRange(immediate, -16, 15)) {
                            error(l, 'Constant is out of range!');
                            return;
                        }
                        instruction |= (1 << 5);
                        instruction |= LC3Util.toInt16(immediate) & 0x1F;
                    }
                } else if (opcode === 0) {
                    // One of the eight BR functions.
                    if (opcount !== 1) {
                        errorOpcount(l, 1, opcount);
                    }
                    var n = command.indexOf('N') !== -1;
                    var z = command.indexOf('Z') !== -1;
                    var p = command.indexOf('P') !== -1;
                    // In assembly, BR = BRnzp.
                    if (!(n || z || p)) {
                        n = z = p = true;
                    }
                    // Set the appropriate bits.
                    var nzp = (n ? 4 : 0) | (z ? 2 : 0) | (p ? 1 : 0);
                    instruction |= (nzp << 9);
                    var offset = parseRelativeAddress(pc, operands[0], 9);
                    if (isNaN(offset)) {
                        error(l, offset);
                        return;
                    }
                    instruction |= offset;
                } else if (command === 'JMP') {
                    if (opcount !== 1) {
                        errorOpcount(l, 1, opcount);
                    }
                    var base = parseRegister(operands[0]);
                    if (isNaN(base)) {
                        error(l, base);
                        return;
                    }
                    instruction |= (base << 6);
                } else if (command === 'RET') {
                    console.log('warning: RET not handled as nullary!');
                    if (opcount !== 0) {
                        errorOpcount(l, 0, opcount);
                        return;
                    }
                    instruction = 0xC1C0;
                } else if (command === 'JSR') {
                    if (opcount !== 1) {
                        errorOpcount(l, 1, opcount);
                        return;
                    }
                    var offset = parseRelativeAddress(pc, operands[0], 11);
                    if (isNaN(offset)) {
                        error(l, offset);
                        return;
                    }
                    instruction |= offset;
                } else if (command === 'JSRR') {
                    if (opcount !== 1) {
                        errorOpcount(l, 1, opcount);
                        return;
                    }
                    var base = parseRegister(operands[0]);
                    if (isNaN(base)) {
                        error(l, base);
                        return;
                    }
                    instruction |= (base << 6);
                } else if (command === 'LD'
                        || command === 'LDI'
                        || command === 'LEA'
                        || command === 'ST'
                        || command === 'STI') {
                    if (opcount !== 2) {
                        errorOpcount(l, 2, opcount);
                        return;
                    }
                    // This is DR for loads, and SR for stores.
                    var register = parseRegister(operands[0]);
                    if (isNaN(register)) {
                        error(l, register);
                        return;
                    }
                    instruction |= (register << 9);
                    var offset = parseRelativeAddress(pc, operands[1], 9);
                    if (isNaN(offset)) {
                        error(l, offset);
                        return;
                    }
                    instruction |= offset;
                } else if (command === 'LDR' || command === 'STR') {
                    if (opcount !== 3) {
                        errorOpcount(l, 3, opcount);
                        return;
                    }
                    // This is DR for loads, and SR for stores.
                    var register = parseRegister(operands[0]);
                    if (isNaN(register)) {
                        error(l, register);
                        return;
                    }
                    instruction |= (register << 9);
                    var base = parseRegister(operands[1]);
                    if (isNaN(base)) {
                        error(l, base);
                        return;
                    }
                    instruction |= (base << 6);
                    // Note: this is *not* a PC offset!
                    var offset = parseLiteral(operands[2]);
                    if (isNaN(offset)) {
                        error(l, offset);
                        return;
                    }
                    if (!inRange(offset, -32, 31)) {
                        error(l, 'Offset is out of range!');
                        return;
                    }
                    instruction |= offset;
                } else if (command === 'NOT') {
                    if (opcount !== 2) {
                        errorOpcount(l, 2, opcount);
                    }
                    var dr = parseRegister(operands[0]);
                    var sr = parseRegister(operands[0]);
                    if (isNaN(dr)) {
                        error(l, dr);
                        return;
                    }
                    if (isNaN(sr)) {
                        error(l, sr);
                        return;
                    }
                    instruction |= (dr << 9);
                    instruction |= (sr << 9);
                    instruction |= (1 << 6) - 1; // should be one-filled
                } else if (command === 'RTI') {
                    console.log('warning: RTI not handled as nullary!');
                    if (opcount !== 0) {
                        errorOpcount(l, 0, opcount);
                        return;
                    }
                    instruction = 0x8000;
                } else if (command === 'TRAP') {
                    if (opcount !== 1) {
                        errorOpcount(l, 1, opcount);
                        return;
                    }
                    var vector = parseLiteral(operands[0]);
                    if (isNaN(vector)) {
                        error(l, vector);
                        return;
                    }
                    if (!inRange(vector, 0x00, 0xFF)) {
                        error(l, 'Trap vector out of range!');
                        return;
                    }
                    instruction |= vector;
                } else {
                    console.log('warning: unhandled instruction: ' + command);
                }
                // If we get here, there was no error.
                // Store the instruction and increment our page.
                mc[index] = instruction;
                pageAddress++;
            }
        };

        for (var i = begin; i < lines.length; i++) {
            var line = lines[i];
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
            // Otherwise, let's take a look at the data.
            if (length === 1) {
                var data = line[0];
                // This could be a line with a nullary instruction,
                // like RET, HALT, etc.
                if (data.toUpperCase() in nullaries) {
                    // No problem here.
                    // Determine the contents and add to the machine code.
                    mc[pageAddress - orig] = nullaries[data.toUpperCase()];
                    pageAddress++;
                    continue;
                }
                // No instruction. This is a label-only line.
                // This was already handled in the symbol table generation.
                continue;
            } else if (length === 2) {
                // This could be an operation and its operands,
                // or a label and a nullary operation.
                var fst = line[0], snd = line[1];
                if (snd.toUpperCase() in nullaries) {
                    // Label and nullary instruction.
                    mc[pageAddress - orig] = nullaries[snd.toUpperCase()];
                    pageAddress++;
                } else {
                    // Instruction and operands.
                    applyInstruction(i, fst, snd);
                }
            } else if (length === 3) {
                // This is a label, an instruction, and its operands.
                // The label's already been handled.
                applyInstruction(i, line[1], line[2]);
            } else {
                // Uh, that shouldn't be.
                error(i, 'Too many tokens! I give up.');
            }
        }

        // Package result and return.
        if (errors.length > 0) {
            return { error: errors };
        } else {
            return { code: mc };
        }
    };

    // Actual assembly function (combines the above steps).
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
        var length = symbolTable.length;

        // Generate the machine code.
        var mc = generateMachineCode(tokens, orig, begin, length, symbols);
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
