var assemble = (function() {

    /*
     * Here follow a few helper functions used for parsing.
     */

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
        var first = literal.charAt(0);
        if (first === '#' || first.toLowerCase() === 'x') {
            // Standard decimal or hexadecimal literal.
            var invalidMessage;
            var toParse;
            var negate = (literal.charAt(1) === '-');
            if (first === '#') {
                toParse = literal.substring(negate ? 2 : 1);
                invalidMessage = 'Invalid decimal literal!';
            } else {
                toParse = negate ? first + literal.substring(2) : literal;
                invalidMessage = 'Invalid hexadecimal literal!';
            }
            var num = LC3Util.parseNumber(toParse);
            if (isNaN(num)) {
                return invalidMessage;
            }
            if (negate && num < 0) {
                // No double negatives.
                // (I tried a pun, but they were just too bad.)
                return invalidMessage;
            }
            return negate ? -num : num;
        } else {
            return 'Invalid literal!';
        }
    };


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

        // Determines whether a potential label name is valid.
        var labelNameOkay = function(label) {
            var x;
            if (label.match(/[^A-Za-z0-9_]/)) {
                // Invalid characters
                return false;
            }
            if (!isNaN(parseLiteral(label))) {
                // Valid literal; clash.
                return false;
            }
            return true;
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
                var count = parseLiteral(operand);
                if (isNaN(count)) {
                    count = LC3Util.parseNumber(operand);
                }
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

        var hasEnd = false;
        for (var i = begin; i < tokenizedLines.length; i++) {
            var line = tokenizedLines[i];
            var length = line.length;
            if (length === 0) {
                continue;
            }
            // First, check if we're done.
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
                error(i, 'Outside maximum memory address! Aborting.');
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
                    error(i, 'Label name invalid!');
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
                var label = line[0];
                if (!labelNameOkay(label)) {
                    error(i, 'Label name invalid!');
                } else if (label in symbols) {
                    error(i, 'Label name "' + label + '" already exists!');
                } else {
                    // We're okay.
                    // Add the label, but don't increment the page address.
                    symbols[label] = pageAddress;
                }
                pageAddress += lengthOf(line[1], line[2]);
            } else {
                // Uh, that shouldn't be.
                error(i, 'Too many tokens! I give up.');
            }
            // Make sure this wasn't, e.g., a .BLKW on the edge of memory.
            if (pageAddress > 0x10000) {
                error(i, 'Outside maximum memory address! Aborting.');
                break;
            }
        }
        if (!hasEnd) {
            error(i, 'No .END directive found!');
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
                    var num = parseLiteral(operand);
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
                    // We'll be a little lenient, and allow either
                    // an actual literal (#1234 or x1234)
                    // or just a raw decimal (1234).
                    var length = parseLiteral(operand);
                    if (isNaN(length)) {
                        length = LC3Util.parseNumber(operand);
                    }
                    if (isNaN(length)) { // still, with new value
                        error(l, 'Operand to .BLKW is not a valid literal!');
                        return;
                    } else if (length < 0) {
                        error(l, 'Operand to .BLKW must be non-negative!');
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
                    'JSRR':  4,
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
                    instruction |= 0x0800; // immediate mode flag
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
                    instruction |= LC3Util.toUint16(offset) & 0x03F;
                } else if (command === 'NOT') {
                    if (opcount !== 2) {
                        errorOpcount(l, 2, opcount);
                    }
                    var dr = parseRegister(operands[0]);
                    var sr = parseRegister(operands[1]);
                    if (isNaN(dr)) {
                        error(l, dr);
                        return;
                    }
                    if (isNaN(sr)) {
                        error(l, sr);
                        return;
                    }
                    instruction |= (dr << 9);
                    instruction |= (sr << 6);
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

// Transpiled via Babel. Good luck.
// I'll publish the new version when it's ready! :)
var assembleBeta = (function() {
    if (!Array.prototype.includes) {
      Array.prototype.includes = function(searchElement /*, fromIndex*/ ) {
        'use strict';
        var O = Object(this);
        var len = parseInt(O.length) || 0;
        if (len === 0) {
          return false;
        }
        var n = parseInt(arguments[1]) || 0;
        var k;
        if (n >= 0) {
          k = n;
        } else {
          k = len + n;
          if (k < 0) {k = 0;}
        }
        var currentElement;
        while (k < len) {
          currentElement = O[k];
          if (searchElement === currentElement ||
             (searchElement !== searchElement && currentElement !== currentElement)) {
            return true;
          }
          k++;
        }
        return false;
      };
    }

    /*
     * Decorate the given function such that it will always return
     * an object with a boolean "success" key
     * and either a "result" or "errorMessage" key
     * containing either the result of a successful invocation
     * or the text of the error thrown during a failed invocation.
     *
     * For example, if f = handleErrors((x) => x.y),
     * then f({ y: 1 }) = { success: true, result: 1 },
     * and f(null) = { success: false, errorMessage: "Cannot read property..." }.
     */
    'use strict';

    var exports = {};
    Object.defineProperty(exports, '__esModule', {
        value: true
    });

    var _slicedToArray = (function () { function sliceIterator(arr, i) { var _arr = []; var _n = true; var _d = false; var _e = undefined; try { for (var _i = arr[Symbol.iterator](), _s; !(_n = (_s = _i.next()).done); _n = true) { _arr.push(_s.value); if (i && _arr.length === i) break; } } catch (err) { _d = true; _e = err; } finally { try { if (!_n && _i['return']) _i['return'](); } finally { if (_d) throw _e; } } return _arr; } return function (arr, i) { if (Array.isArray(arr)) { return arr; } else if (Symbol.iterator in Object(arr)) { return sliceIterator(arr, i); } else { throw new TypeError('Invalid attempt to destructure non-iterable instance'); } }; })();

    var _extends = Object.assign || function (target) { for (var i = 1; i < arguments.length; i++) { var source = arguments[i]; for (var key in source) { if (Object.prototype.hasOwnProperty.call(source, key)) { target[key] = source[key]; } } } return target; };

    exports.handleErrors = handleErrors;
    exports.withContext = withContext;
    exports.parseNumber = parseNumber;
    exports.toHexString = toHexString;
    exports.toInt16 = toInt16;
    exports.toUint16 = toUint16;
    exports.signExtend16 = signExtend16;
    exports.getConditionCode = getConditionCode;
    exports.formatConditionCode = formatConditionCode;
    exports['default'] = assemble;
    exports.parseRegister = parseRegister;
    exports.parseLiteral = parseLiteral;
    exports.parseString = parseString;
    exports.tokenize = tokenize;
    exports.findOrig = findOrig;
    exports.isValidLabelName = isValidLabelName;
    exports.determineRequiredMemory = determineRequiredMemory;
    exports.buildSymbolTable = buildSymbolTable;
    exports.parseOffset = parseOffset;
    exports.encodeDirective = encodeDirective;
    exports.encodeInstruction = encodeInstruction;
    exports.generateMachineCode = generateMachineCode;

    function _toConsumableArray(arr) { if (Array.isArray(arr)) { for (var i = 0, arr2 = Array(arr.length); i < arr.length; i++) arr2[i] = arr[i]; return arr2; } else { return Array.from(arr); } }

    function _toArray(arr) { return Array.isArray(arr) ? arr : Array.from(arr); }

    function _defineProperty(obj, key, value) { if (key in obj) { Object.defineProperty(obj, key, { value: value, enumerable: true, configurable: true, writable: true }); } else { obj[key] = value; } return obj; }

    function handleErrors(callback) {
        var errfmt = arguments.length <= 1 || arguments[1] === undefined ? function (x) {
            return x;
        } : arguments[1];

        return function () {
            try {
                return {
                    success: true,
                    result: callback.apply(undefined, arguments)
                };
            } catch (e) {
                return {
                    success: false,
                    errorMessage: errfmt(e.message)
                };
            }
        };
    }

    /*
     * Decorate the given callback such that any error messages it throws
     * will have the given context and ": " prepended.
     *
     * For example, if context is "while doing a thing"
     * and the callback ends up throwing an error "something happened,"
     * the caller will see the error "while doing a thing: something happened."
     */

    function withContext(callback, context) {
        return function () {
            try {
                return callback.apply(undefined, arguments);
            } catch (e) {
                throw new Error(context + ': ' + e.message);
            }
        };
    }

    /*
     * Number of addressable locations in the LC3 memory.
     */
    var MEMORY_SIZE = 0x10000;

    exports.MEMORY_SIZE = MEMORY_SIZE;
    /*
     * The number of bits in an LC3 machine word.
     */
    var WORD_BITS = 16;

    exports.WORD_BITS = WORD_BITS;
    /*
     * Any addresses greater than or equal to this one
     * are mapped to devices or reserved for the system.
     */
    var MAX_STANDARD_MEMORY = 0xFE00;

    exports.MAX_STANDARD_MEMORY = MAX_STANDARD_MEMORY;
    var Constants = {
        MEMORY_SIZE: MEMORY_SIZE,
        WORD_BITS: WORD_BITS,
        MAX_STANDARD_MEMORY: MAX_STANDARD_MEMORY
    };

    /*
     * Convert a decimal or hex string to a number.
     * Return NaN on failure.
     */

    function parseNumber(string) {
        string = string.toLowerCase();
        if (string.length === 0) {
            return NaN;
        }

        var negative = false;
        if (string[0] === '-') {
            string = string.slice(1);
            negative = true;
        }

        var num = undefined;
        if (string[0] === 'x') {
            var hexDigits = string.slice(1);
            if (hexDigits.match(/[^0-9a-f]/)) {
                return NaN;
            }
            num = parseInt(hexDigits, 16);
        } else {
            if (string.match(/[^0-9]/)) {
                return NaN;
            }
            num = parseInt(string);
        }
        return negative ? -num : num;
    }

    /*
     * Convert a number to a hex string of at least four digits,
     * prefixed with an "x."
     *
     * The second and third parameters, respectively,
     * can specify alternate values for the minimum digit count
     * and the prefix with which to pad.
     */

    function toHexString(number) {
        var padLength = arguments.length <= 1 || arguments[1] === undefined ? 4 : arguments[1];
        var prefix = arguments.length <= 2 || arguments[2] === undefined ? 'x' : arguments[2];

        var hex = number.toString(16).toUpperCase();
        if (hex.length < padLength) {
            hex = Array(padLength - hex.length + 1).join('0') + hex;
        }
        return prefix + hex;
    }

    /*
     * Convert a number possibly outside the [-32768, 32767] range
     * to a 16-bit signed integer.
     */

    function toInt16(n) {
        n = n % (1 << WORD_BITS) & (1 << WORD_BITS) - 1;
        if (n & 1 << WORD_BITS - 1) {
            return n - (1 << WORD_BITS);
        }
        return n;
    }

    /*
     * Convert a number possibly outside the [-32768, 32767] range
     * to a 16-bit unsigned signed integer.
     */

    function toUint16(n) {
        var int16 = toInt16(n);
        return int16 < 0 ? int16 + (1 << WORD_BITS) : int16;
    }

    /*
     * Assuming that the given number represents a signed integer
     * with the given number of bits,
     * sign-extend this to a 16-bit number.
     * For example, the 5-bit signed number 10001 represents -15,
     * so signExtend(0b10001, 5) === signExtend(17, 5) === -15.
     */

    function signExtend16(n, bits) {
        var justSignBit = n & 1 << bits - 1;
        if (justSignBit) {
            return toInt16(n - (1 << bits));
        } else {
            return toInt16(n & (1 << bits) - 1);
        }
    }

    /*
     * Get the condition code as -1, 0, or 1,
     * or null if the PSR is in an invalid state.
     */

    function getConditionCode(psr) {
        var n = psr & 0x4;
        var z = psr & 0x2;
        var p = psr & 0x1;

        // Make sure exactly one condition code is set.
        if (!!n + !!z + !!p !== 1) {
            return null;
        }

        return n ? -1 : p ? 1 : 0;
    }

    /*
     * Get the condition code as "N", "Z", or "P",
     * or "Invalid" if the PSR is in an invalid state.
     *
     * This just uses the result of getConditionCode.
     */

    function formatConditionCode(psr) {
        switch (getConditionCode(psr)) {
            case null:
                return "Invalid";
            case -1:
                return "N";
            case 0:
                return "Z";
            case 1:
                return "P";
        }
    }

    var Utils = {
        parseNumber: parseNumber,
        toHexString: toHexString,
        toInt16: toInt16,
        toUint16: toUint16,
        signExtend16: signExtend16,
        getConditionCode: getConditionCode,
        formatConditionCode: formatConditionCode
    };

    function assemble(text) {
        var result = handleErrors(function () {
            var tokenizedLines = tokenize(text);

            var _findOrig = findOrig(tokenizedLines);

            var orig = _findOrig.orig;
            var begin = _findOrig.begin;

            var _buildSymbolTable = buildSymbolTable(tokenizedLines, orig, begin);

            var symbolTable = _buildSymbolTable.symbolTable;
            var programLength = _buildSymbolTable.programLength;

            var machineCode = generateMachineCode(tokenizedLines, symbolTable, orig, begin);
            return { orig: orig, symbolTable: symbolTable, machineCode: machineCode };
        })(text);

        if (result.success) {
            return result.result;
        } else {
            return { error: [result.errorMessage] };
        }
    }

    function parseRegister(text) {
        var match = text.match(/^[Rr]([0-7])$/);
        if (match) {
            return parseInt(match[1]);
        } else {
            throw new Error('Invalid register specification: \'' + text + '\'');
        }
    }

    function parseLiteral(text) {
        var e = new Error('Invalid numeric literal: \'' + text + '\'');
        var first = text.charAt(0);
        if (first !== '#' && first.toLowerCase() !== 'x') {
            throw e;
        }

        // Standard decimal or hexadecimal literal.
        var isDecimal = first === '#';
        var negate = text.charAt(1) === '-';
        var toParse = isDecimal ? text.substring(negate ? 2 : 1) : negate ? first + text.substring(2) : text;

        var num = Utils.parseNumber(toParse);
        if (isNaN(num)) {
            throw e;
        }
        if (negate && num < 0) {
            // No double negatives.
            throw e;
        }
        return negate ? -num : num;
    }

    /*
     * Parse a raw string as it appears in the assembly source code---
     * in the form including the outer quotation marks---
     * into what it should represent in machine code.
     * In particular, this includes stripping the outer quotes
     * and performing backslash-escapes.
     * If the string is invalid, an error will be thrown.
     */

    function parseString(text) {
        var error = function error(message) {
            throw new Error('while parsing the string ' + text + ': ' + message);
        };

        if (text.length < 2) {
            error('this string is way too short! ' + "You need at least two characters just for the quote marks.");
        }

        var quote = '"';
        if (text.charAt(0) !== quote || text.charAt(text.length - 1) !== quote) {
            error('the string needs to start and end with ' + ('double quotation marks (e.g.: ' + quote + 'I\'m a string' + quote + ').'));
        }

        // We'll build up this list of single-character strings,
        // then join them at the end.
        // (This might end up being a tad sparse if we skip some backslashes;
        // that's okay, because Array.join will deal with these holes fine.)
        var chars = new Array(text.length - 2);

        // This has to be a mutable-style for loop instead of a call to map
        // because we need to be able to conditionally move the iterator
        // (e.g., read the next character to process and escape sequence).
        var i = undefined;
        for (i = 1; i < text.length - 1; i++) {
            var here = text.charAt(i);
            var errorHere = function errorHere(message) {
                return error('at index ' + i + ': ' + message);
            };

            if (here === '"') {
                errorHere('unescaped double quote found before end of string');
            }

            if (here === '\\') {
                // Supported escape sequences: \0, \n, \r, \", \\.
                var escapeSequence = text.charAt(++i);

                // Note: if the backslash is the last character of the string,
                // meaning that the closing quote is escaped
                // and the string is invalid,
                // this particular character will just resolve to a quote,
                // and no error will be raised.
                // We check for this case separately down below.
                var escaped = ({
                    '0': '\0',
                    'n': '\n',
                    'r': '\r',
                    '"': '\"',
                    '\\': '\\'
                })[escapeSequence];

                if (escapeSequence === undefined) {
                    errorHere('unsupported escape character \'' + escapeSequence + '\'');
                }
                chars[i] = escaped;
            } else {
                chars[i] = here;
            }
        }

        // Now make sure that the last body character wasn't a backslash,
        // which would mean that we escaped the final closing quote.
        if (i >= text.length || text.charAt(i) !== '"') {
            error("unterminated string literal! " + "Did you accidentally backslash-escape the closing quote?");
        }

        return chars.join('');
    }

    /*
     * Tokenize the given document.
     * Returns an array of lines; each line is an array of tokens.
     * Comma-separated operands are smashed into one token.
     * Comments are stripped.
     * Strings are resolved, and an error is thrown if they are invalid.
     *
     * Sample tokenizations:
     *   - '.ORIG x3000' goes to [[".ORIG", "x3000"]]
     *   - 'ADD R1, R2, R3' goes to [["ADD", "R1,R2,R3"]]
     *   - '.STRINGZ "with spaces"' goes to [[".STRINGZ", "with spaces"]]
     *   - 'RET  ; go back' goes to [["RET"]]
     *   - '; thing \n RET ; thing \n ; thing' goes to [[], ["RET"], []]
     */

    function tokenize(text) {
        return text.split(/\r?\n/).map(tokenizeLine);
    }

    // See documentation for tokenize.
    function tokenizeLine(line, lineIndex) {
        // Trim leading whitespace.
        // We can't trim trailing or interior whitespace or comments at this point
        // because those might belong to string literals.
        var trimmed = line.trimLeft();

        // Include the line number when we parse string literals
        // so that error messages are more helpful.
        var parseStringCtx = withContext(parseString, 'on line ' + (lineIndex + 1));

        // Now we execute a small state machine.
        // At any point, we can be
        //   * ready to start a new token;
        //   * in the middle of a token; or
        //   * in the middle of a string.
        var IDLE = 0;
        var TOKEN = 1;
        var STRING = 2;

        var state = IDLE;

        // These are the list of tokens/strings we've collected so far
        // (which will be the return value of this function)
        // and the value of the token/string currently being built.
        var tokens = [];
        var current = "";

        for (var i = 0; i < line.length; i++) {
            var here = trimmed.charAt(i);
            var isWhitespace = !!here.match(/\s/);
            var isComma = here === ',';
            var isQuote = here === '"';

            if (state === IDLE) {
                if (isWhitespace || isComma) {
                    continue;
                } else {
                    state = isQuote ? STRING : TOKEN;
                }
            }

            // Break at comments, unless we're inside a string.
            if (here === ';' && state !== STRING) {
                break;
            }

            if (state === TOKEN) {
                // Break tokens at commas and whitespace.
                if (isWhitespace || isComma) {
                    tokens.push(current);
                    state = IDLE;
                    current = "";
                } else {
                    current += here;
                }
            } else if (state === STRING) {
                current += here; // includes the quotation marks
                if (here === '\\') {
                    // All our escape sequences are just one character,
                    // so we can just read that in. Easy.
                    current += trimmed.charAt(++i);
                } else if (isQuote && current.length > 1) {
                    tokens.push(parseStringCtx(current));
                    state = IDLE;
                    current = "";
                }
            }
        }

        // Finally, add any tokens that extended to the end of the line.
        if (current.length > 0) {
            if (state === TOKEN) {
                tokens.push(current);
            } else if (state === STRING) {
                tokens.push(parseStringCtx(current));
            }
        }

        return tokens;
    }

    /*
     * Attempt to find the .ORIG directive.
     *
     * On success, the return value is an object with the fields
     *   - orig: the origin address specified in the .ORIG directive
     *   - begin: (zero-based) index of the first line after the .ORIG
     *
     * Throws an error message on failure.
     */

    function findOrig(tokenizedLines) {
        // The .ORIG directive needs to be on the first non-blank line
        // (after tokenizing, which strips whitespace and comments).
        var lineNumber = tokenizedLines.findIndex(function (line) {
            return line.length > 0;
        });
        if (lineNumber === -1) {
            throw new Error("Looks like your program's empty! " + "You need at least an .ORIG directive and an .END directive.");
        }
        var line = tokenizedLines[lineNumber];

        // Check if there's an .ORIG directive anywhere in the line.
        var hasOrig = line.some(function (token) {
            return token.toUpperCase() === ".ORIG";
        });
        if (!hasOrig) {
            throw new Error("The first non-empty, non-comment line of your program " + "needs to have an .ORIG directive!");
        }

        // There's a directive somewhere.
        // If it's not the first, then there's a label. Not allowed.
        if (line[0].toUpperCase() !== ".ORIG") {
            throw new Error(".ORIG directive cannot have a label!");
        }

        // If there's additional junk, that's not okay.
        // If there's no operand, that's not okay, either.
        var operands = line.length - 1;
        if (operands !== 1) {
            throw new Error('The .ORIG directive expects exactly one operand, ' + ('but it looks like you have ' + operands + '!'));
        }

        // Well, there's something. Is it a number?
        var operand = line[1];
        var orig = withContext(parseLiteral, "while parsing .ORIG directive operand")(operand);

        // Is it in range?
        if (orig !== Utils.toUint16(orig)) {
            throw new Error('.ORIG operand (' + operand + ') is out of range! ' + 'It should be between 0 and 0xFFFF, inclusive.');
        }

        // Looks like we're good.
        return {
            orig: orig,
            begin: lineNumber + 1
        };
    }

    /*
     * Test whether the given string might be a valid label name.
     * Note that this does not check for name clashes with existing labels.
     */

    function isValidLabelName(label) {
        if (label.match(/[^A-Za-z0-9_]/)) {
            // Invalid characters.
            return false;
        }

        var asLiteral = handleErrors(parseLiteral)(label);
        if (asLiteral.success) {
            // Valid literal; could be ambiguous.
            return false;
        }

        return true;
    }

    /*
     * Determine how many words of LC-3 memory
     * the given instruction or directive will require to be allocated.
     *
     * The command should be a string like ".FILL" or "BRnp".
     *
     * The operand should be a number for .FILL or .BLKW,
     * a string value for .STRINGZ,
     * or null (or any other value) if it's an instruction
     * (because the operand of an instruction doesn't influence its size).
     *
     * Special cases like ".ORIG" and ".END" are not supported by this function.
     * You should process those separately.
     */

    function determineRequiredMemory(command, operand) {
        switch (command) {
            case ".FILL":
                return 1;
            case ".BLKW":
                if (operand < 0) {
                    throw new Error('a .BLKW needs to have a non-negative length, ' + ('but I found ' + operand));
                }
                return operand;
            case ".STRINGZ":
                return operand.length + 1; // for the null-terminator
            default:
                // Assume it's a normal instruction.
                return 1;
        }
    }

    function buildSymbolTable(lines, orig, begin) {
        var initialState = {
            symbols: {},
            address: orig,
            seenEndDirective: false
        };
        var checkBounds = function checkBounds(address) {
            var max = Constants.MEMORY_SIZE;
            if (address > max) {
                throw new Error('currently at address ' + Utils.toHexString(address) + ', ' + 'which is past the memory limit ' + ('of ' + Utils.toHexString(max)));
            }
        };
        var advance = function advance(state, amount) {
            var newAddress = state.address + amount;
            checkBounds(newAddress);
            return _extends({}, state, { address: newAddress });
        };
        var handlers = {
            handleEnd: function handleEnd(state) {
                return _extends({}, state, { seenEndDirective: true });
            },
            handleLabel: function handleLabel(state, line) {
                // A label must refer to a valid memory location,
                // so the *next* address must be valid.
                checkBounds(state.address + 1);

                var labelName = line[0];
                var existingLocation = state.symbols[labelName];
                if (existingLocation !== undefined) {
                    throw new Error('label name ' + labelName + ' already exists; ' + ('it points to ' + Utils.toHexString(existingLocation)));
                } else {
                    // Go ahead and add it to the symbol table!
                    return _extends({}, state, {
                        symbols: _extends({}, state.symbols, _defineProperty({}, labelName, state.address))
                    });
                }
            },
            handleDirective: function handleDirective(state, line) {
                if (state.seenEndDirective) {
                    return state;
                }

                var _line2 = _toArray(line);

                var command = _line2[0];

                var operands = _line2.slice(1);

                var operand = (function () {
                    var ensureUnary = function ensureUnary() {
                        if (operands.length !== 1) {
                            throw new Error('expected ' + command + ' directive ' + 'to have exactly one operand, ' + ('but found ' + operands.length));
                        }
                    };
                    switch (command) {
                        case ".BLKW":
                        case ".FILL":
                            ensureUnary();
                            return parseLiteral(operands[0]);
                        case ".STRINGZ":
                            ensureUnary();
                            return operands[0]; // already a string, from tokenize
                        default:
                            // encodeDirective will throw an error at assembly time
                            return null;
                    }
                })();
                return advance(state, determineRequiredMemory(command, operand));
            },
            handleInstruction: function handleInstruction(state, line) {
                if (state.seenEndDirective) {
                    return state;
                }
                return advance(state, determineRequiredMemory(line[0], null));
            }
        };
        var finalState = reduceProgram(lines, begin, handlers, initialState);

        if (!finalState.seenEndDirective) {
            throw new Error("no .END directive found!");
        }

        return {
            symbolTable: finalState.symbols,
            programLength: finalState.address - orig
        };
    }

    /*
     * Parse a PC-relative offset, provided in either literal or label form.
     * The result is an integer offset from the provided PC location.
     * For example, if PC is 0x3000 and the operand points to a label at 0x2FFF,
     * the return value will be -1.
     *
     * If the signed offset does not fit into the given number of bits,
     * or if the operand refers to a label that does not exist,
     * an error will be thrown.
     */

    function parseOffset(pc, operand, symbols, bits) {
        var ensureInRange = function ensureInRange(x) {
            var min = -(1 << bits - 1);
            var max = (1 << bits - 1) - 1;
            if (!(min <= x && x <= max)) {
                throw new Error('offset ' + x + ' is out of range; ' + ('it must fit into ' + bits + ' bits, ') + ('so it should be between ' + min + ' and ' + max + ', inclusive'));
            }
            return x;
        };

        // First, see if it's a valid literal.
        var asLiteral = handleErrors(parseLiteral)(operand);
        if (asLiteral.success) {
            return ensureInRange(asLiteral.result);
        }

        // If it's not a literal, it must be a symbol to be valid.
        if (!(operand in symbols)) {
            throw new Error('the offset \'' + operand + '\' is not a valid numeric literal, ' + 'but I can\'t find it in the symbol table either; ' + 'did you misspell a label name?');
        }

        var symbolAddress = symbols[operand];
        return ensureInRange(symbolAddress - pc);
    }

    /*
     * Generate the machine code output for an assembly directive.
     * The tokens parameter should be a single tokenized line, excluding any label.
     * The result is an array of LC-3 machine words (integers)
     * to be appended to the machine code.
     *
     * Assembly directives don't depend on the current PC or the symbol table,
     * so these don't need to be passed in as arguments.
     */

    function encodeDirective(tokens) {
        var directive = tokens[0];
        var operand = tokens[1];

        switch (directive.toUpperCase()) {
            case ".FILL":
                return [Utils.toUint16(parseLiteral(operand))];
            case ".BLKW":
                return new Array(Utils.toUint16(parseLiteral(operand))).fill(0);
            case ".STRINGZ":
                return operand.split('').map(function (c) {
                    return c.charCodeAt(0);
                }).concat([0]);
            default:
                throw new Error('unrecognized directive: ' + directive);
        }
    }

    /*
     * Generate the machine code output for an LC-3 instruction.
     * The tokens parameter should be a single tokenized line, excluding any label.
     * The PC should be the value of the PC when the instruction is executed
     * (i.e., one past the address at which the instruction is stored).
     * The symbols parameter should be an object mapping label names to addresses.
     * The result is an array of LC-3 machine words (integers)
     * to be appended to the machine code.
     */

    function encodeInstruction(tokens, pc, symbols) {
        var opname = tokens[0];
        var upname = opname.toUpperCase();
        var operands = tokens.slice(1);

        var ensureOpcount = function ensureOpcount(expected) {
            if (operands.length !== expected) {
                var noun = expected === 1 ? "operand" : "operands";
                throw new Error('expected ' + opname + ' instruction to have ' + ('exactly ' + expected + ' ' + noun + ', but found ' + operands.length));
            }
        };

        var inBits = function inBits(x, bits, description) {
            var min = -(1 << bits - 1);
            var max = (1 << bits - 1) - 1;
            if (min <= x && x <= max) {
                return Utils.toUint16(x) & (1 << bits) - 1;
            } else {
                throw new Error(description + ' is out of range: ' + ('expected value to fit in ' + bits + ' bits ') + ('(i.e., to be between ' + min + ' and ' + max + ', inclusive), ') + ('but found ' + x));
            }
        };

        /*
         * Parse an offset, then force it into the given bit width.
         * This is like parseOffset except that "#-1" maps to, e.g., 0b11111
         * instead of a literal -1.
         */
        var extractOffset = function extractOffset(offset, bits) {
            var ctx = 'while parsing the offset for a ' + opname;
            var parsed = withContext(parseOffset, ctx)(pc, offset, symbols, bits);
            return Utils.toUint16(parsed) & (1 << bits) - 1;
        };

        // Handle the trap service routines specially.
        var systemTraps = {
            "GETC": 0x20,
            "OUT": 0x21,
            "PUTS": 0x22,
            "IN": 0x23,
            "PUTSP": 0x24,
            "HALT": 0x25
        };
        var systemTrapVector = systemTraps[upname];
        if (systemTrapVector !== undefined) {
            ensureOpcount(0);
            return [0xF000 | systemTrapVector];
        }

        var instructions = {
            "ADD": 1,
            "AND": 5,
            "NOT": 9,
            "BR": 0,
            "BRP": 0,
            "BRZ": 0,
            "BRZP": 0,
            "BRN": 0,
            "BRNP": 0,
            "BRNZ": 0,
            "BRNZP": 0,
            "JMP": 12,
            "RET": 12,
            "JSR": 4,
            "JSRR": 4,
            "LD": 2,
            "LDI": 10,
            "LDR": 6,
            "LEA": 14,
            "RTI": 8,
            "ST": 3,
            "STI": 11,
            "STR": 7,
            "TRAP": 15
        };
        var opcode = instructions[upname];

        if (opcode === undefined) {
            throw new Error('unrecognized instruction "' + opname + '"');
        }

        var baseop = opcode << 12;

        if (upname === "ADD" || upname === "AND") {
            ensureOpcount(3);

            var _operands$slice$map = operands.slice(0, 2).map(function (x) {
                return parseRegister(x);
            });

            var _operands$slice$map2 = _slicedToArray(_operands$slice$map, 2);

            var dr = _operands$slice$map2[0];
            var sr1 = _operands$slice$map2[1];

            var last = operands[2];
            var asLiteral = handleErrors(parseLiteral)(last);
            var sr2OrImm = asLiteral.success ? 32 | inBits(asLiteral.result, 5, "immediate field") : 0 | parseRegister(last);
            return [baseop | dr << 9 | sr1 << 6 | sr2OrImm];
        } else if (opcode === 0) {
            // This is one of the eight BR variants.
            ensureOpcount(1);

            var _ref = upname === "BR" ? [true, true, true] : // plain "BR" is an unconditional branch
            ["N", "Z", "P"].map(function (x) {
                return upname.substring(2).includes(x);
            });

            var _ref2 = _slicedToArray(_ref, 3);

            var n = _ref2[0];
            var z = _ref2[1];
            var p = _ref2[2];

            var nzp = n << 2 | z << 1 | p << 0;
            var offset = extractOffset(operands[0], 9);
            return [baseop | nzp << 9 | offset];
        } else if (upname === "JMP") {
            ensureOpcount(1);
            return [baseop | parseRegister(operands[0]) << 6];
        } else if (upname === "RET") {
            ensureOpcount(0);
            return [baseop | 7 << 6];
        } else if (upname === "JSR") {
            ensureOpcount(1);
            return [baseop | 1 << 11 | extractOffset(operands[0], 11)];
        } else if (upname === "JSRR") {
            ensureOpcount(1);
            return [baseop | 0 << 11 | parseRegister(operands[0]) << 6];
        } else if (["LD", "LDI", "LEA", "ST", "STI"].includes(upname)) {
            ensureOpcount(2);
            var register = parseRegister(operands[0]); // loads: DR; stores: SR
            var offset = extractOffset(operands[1], 9);
            return [baseop | register << 9 | offset];
        } else if (upname === "LDR" || upname === "STR") {
            ensureOpcount(3);
            var drsr = parseRegister(operands[0]); // DR for LDR; SR for STR
            var baseR = parseRegister(operands[1]);
            var offset = extractOffset(operands[2], 6);
            return [baseop | drsr << 9 | baseR << 6 | offset];
        } else if (upname === "NOT") {
            ensureOpcount(2);
            var dr = parseRegister(operands[0]);
            var sr = parseRegister(operands[1]);
            return [baseop | dr << 9 | sr << 6 | 63];
        } else if (upname === "RTI") {
            ensureOpcount(0);
            return [baseop];
        } else if (upname === "TRAP") {
            ensureOpcount(1);
            var ctx = "while parsing the trap vector";
            var trapVector = withContext(parseLiteral, ctx)(operands[0]);
            if (!(0 <= trapVector && trapVector <= 0xFF)) {
                throw new Error('trap vector out of range: ' + 'expected value to be an unsigned byte ' + '(i.e., between 0 and 255, inclusive), ' + ('but found ' + trapVector));
            }
            return [baseop | trapVector];
        } else {
            throw new Error('internal error: unhandled instruction ' + opname);
        }
    }

    function generateMachineCode(lines, symbols, orig, begin) {
        var initialState = {
            machineCode: [],
            address: orig,
            seenEndDirective: false
        };
        var appendCode = function appendCode(state, code) {
            return _extends({}, state, {
                machineCode: state.machineCode.concat(code),
                address: state.address + code.length
            });
        };
        var handlers = {
            handleDirective: function handleDirective(state, line) {
                if (state.seenEndDirective) {
                    return state;
                }
                return appendCode(state, encodeDirective(line));
            },
            handleInstruction: function handleInstruction(state, line) {
                if (state.seenEndDirective) {
                    return state;
                }
                var pc = state.address + 1;
                return appendCode(state, encodeInstruction(line, pc, symbols));
            },
            handleEnd: function handleEnd(state) {
                return _extends({}, state, { seenEndDirective: true });
            }
        };
        var finalState = reduceProgram(lines, begin, handlers, initialState);

        if (!finalState.seenEndDirective) {
            throw new Error("missing .END directive");
        }
        return finalState.machineCode;
    }

    function reduceProgram(lines, begin, handlers, initialState) {
        var id = function id(x) {
            return x;
        };
        var _handlers$handleLabel = handlers.handleLabel;
        var handleLabel = _handlers$handleLabel === undefined ? id : _handlers$handleLabel;
        var _handlers$handleDirective = handlers.handleDirective;
        var handleDirective = _handlers$handleDirective === undefined ? id : _handlers$handleDirective;
        var _handlers$handleInstruction = handlers.handleInstruction;
        var handleInstruction = _handlers$handleInstruction === undefined ? id : _handlers$handleInstruction;
        var _handlers$handleEnd = handlers.handleEnd;
        var handleEnd = _handlers$handleEnd === undefined ? id : _handlers$handleEnd;

        // Here are all the things that can come at the start of a line.
        // We use these to determine whether the first token in a line
        // is a label or an actual operation of some kind.
        var trapVectors = "GETC OUT PUTS IN PUTSP HALT".split(' ');
        var instructions = ["ADD", "AND", "NOT", "BR", "BRP", "BRZ", "BRZP", "BRN", "BRNP", "BRNZ", "BRNZP", "JMP", "RET", "JSR", "JSRR", "LD", "LDI", "LDR", "LEA", "RTI", "ST", "STI", "STR", "TRAP"];
        var directives = [".FILL", ".BLKW", ".STRINGZ"];
        var commands = [].concat(_toConsumableArray(trapVectors), instructions, directives);

        var program = lines.slice(begin);
        return program.reduce(function (state, line, lineIndex) {
            if (line.length === 0) {
                return state;
            }

            var ctx = 'at line ' + (lineIndex + begin + 1);
            var delegate = function delegate(cb) {
                var _state = arguments.length <= 1 || arguments[1] === undefined ? state : arguments[1];

                var _line = arguments.length <= 2 || arguments[2] === undefined ? line : arguments[2];

                return withContext(cb, ctx)(_state, _line, lineIndex);
            };

            var fst = line[0];
            if (fst.toUpperCase() === ".END") {
                return delegate(handleEnd);
            }

            var hasLabel = !commands.includes(fst.toUpperCase());
            if (hasLabel && !isValidLabelName(fst)) {
                throw new Error(ctx + ': this line looks like a label, ' + ('but \'' + fst + '\' is not a valid label name; ') + 'you either misspelled an instruction ' + 'or entered an invalid name for a label');
            }

            var labeledState = hasLabel ? delegate(handleLabel) : state;
            var rest = line.slice(hasLabel ? 1 : 0);

            if (rest.length === 0) {
                // It's a label-only line. No problem.
                return labeledState;
            }

            var command = rest[0].toUpperCase();
            var isDirective = command.charAt(0) === '.';
            var pc = state.address + 1;
            if (isDirective) {
                return delegate(handleDirective, labeledState, rest);
            } else {
                return delegate(handleInstruction, labeledState, rest);
            }
        }, initialState);
    }

    return assemble;

})();

if (window.location.hash === "#asmfix") {
    assemble = assembleBeta;
}
