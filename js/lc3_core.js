var toInt16 = function(n) {
    n = n & 0xFFFF;
    if (n & 0x8000) {
        return n - 0x10000;
    }
    return n;
};

var LC3 = function() {
    // Create and initialize memory
    this.memory = new Array(0x10000);
    for (var i = 0; i < this.memory.length; i++) {
        this.memory[i] = 0;
    }

    // Listeners for when registers, memory, etc. are changed
    this.listeners = [];
    this.addListener = function(callback) {
        this.listeners.push(callback);
    };
    this.notifyListeners = function(e) {
        for (var i = 0; i < this.listeners.length; i++) {
            this.listeners[i](e);
        }
    };

    // Create and initialize standard registers (R0 to R7)
    this.r = new Array(8);
    for (var i = 0; i < this.r.length; i++) {
        this.r[i] = 0;
    }

    // Initialize special registers
    this.pc = 0x3000;
    this.ir = 0;
    this.psr = 0x0400;
    this.specialRegisters = ['pc', 'ir', 'psr'];

    // Dictionaries for linking addresses and labels
    this.labelToAddress = {};
    this.addressToLabel = {};

    // Exclusive upper bound for normal memory
    // Memory address 0xFE00 and up are mapped to devices
    this.maxStandardMemory = 0xFE00;
}

/*
 * Decodes an instruction to an object containing extractable fields.
 * For example, decode(0x1401) yields:
 *   { opcode: 1, opname: 'ADD', mode: 'reg', dr: 2, sr1: 0, sr2: 1 }
 */
LC3.prototype.decode = function(instruction) {
    // We'll augment this object depending on the opcode.
    var op = {
        raw: instruction,
        strictValid: true,
    };

    var bits = Array(16);
    for (var i = 0; i < bits.length; i++) {
        bits[i] = (instruction >> i) & 0x1;
    }

    op.opcode = (instruction >> 12) & 0xF;

    var bits05 = instruction & 0x3F;
    var bits68 = (instruction >> 6) & 0x7;
    var bits08 = instruction & 0x1FF;
    var bits911 = (instruction >> 9) & 0x7;
    var bits010 = instruction & 0x7FF;

    var valid = true;
    switch (op.opcode) {
        case 1: // ADD
        case 5: // AND
            op.opname = (op.opcode === 1 ? 'ADD' : 'AND');
            op.dr = bits911;
            op.sr1 = bits68;
            if (bits[5] === 0) {
                op.mode = 'reg';
                op.sr2 = instruction & 0x7;
                if (bits[4] !== 0 || bits[3] !== 0) {
                    op.strictValid = false;
                }
            } else {
                op.mode = 'imm';
                op.imm5 = instruction & 0x1F;
            }
            break;
        case 0: // BR
            op.opname = 'BR';
            op.n = (bits[11] == 1);
            op.z = (bits[10] == 1);
            op.p = (bits[9] == 1);
            op.pcOffset9 = bits08;
            break;
        case 12: // JMP, RET
            if (bits911 !== 0 || bits05 !== 0) {
                op.strictValid = false;
            }
            op.baseR = bits68;
            op.opname = (bits68 === 7 ? 'RET' : 'JMP');
            break;
        case 4: // JSR, JSRR
            op.opname = 'JSR';
            if (bits[11] === 0) {
                op.mode = 'reg';
                if (bits911 !== 0 || bits05 !== 0) {
                    op.strictValid = false;
                }
                op.baseR = bits68;
            } else {
                op.mode = 'pcRelative';
                op.pcOffset11 = bits010;
            }
            break;
        case 2:  // LD
        case 10: // LDI
            op.opname = (op.opcode === 2 ? 'LD' : 'LDI');
            op.dr = bits911;
            op.pcOffset9 = bits08;
            break;
        case 6: // LDR
            op.opname = 'LDR';
            op.dr = bits911;
            op.baseR = bits68;
            op.offset = base05;
            break;
        case 14: // LEA
            op.opname = 'LEA';
            op.dr = bits911;
            op.pcOffset9 = bits08;
        case 9: // NOT
            op.opname = 'NOT';
            op.dr = bits911;
            op.sr = bits68;
            if (bits05 !== 0x3F) {
                op.strictValid = false;
            }
            break;
        case 8: // RTI
            op.opname = 'RTI';
            if (instruction & 0xFFF !== 0) {
                op.strictValid = false;
            }
            break;
        case 3:  // ST
        case 11: // STI
            op.opname = (op.opcode === 3 ? 'ST' : 'STI');
            op.sr = bits911;
            op.pcOffset9 = bits08;
            break;
        case 7: // STR
            op.opname = 'STR';
            op.sr = bits911;
            op.baseR = bits68;
            op.offset6 = bits05;
            break;
        case 15: // TRAP
            op.opname = 'TRAP';
            op.trapVector = instruction & 0xFF;
            if (op & 0x0F00 !== 0) {
                op.strictValid = false;
            }
            break;
        default:
            op.opname = 'reserved';
            op.strictValid = false;
            break;
    }
    return op;
};

// Functions to get and set memory, handling mapped memory edge cases
LC3.prototype.getMemory = function(address) {
    return this.memory[address];
}
LC3.prototype.setMemory = function(address, data) {
    var ev = {
        type: 'memset',
        address: address,
        newValue: data
    };
    this.memory[address] = data;
    this.notifyListeners(ev);
};

// Functions to get and set registers (standard or special)
LC3.prototype.getRegister = function(register) {
    for (var i = 0; i < this.r.length; i++) {
        if (i.toString() === register) {
            return this.r[i];
        }
    }
    for (var i = 0; i < this.specialRegisters.length; i++) {
        var name = this.specialRegisters[i];
        if (name === register) {
            return this[name];
        }
    }
    return undefined;
}
LC3.prototype.setRegister = function(register, value) {
    var ev = {
        type: 'regset',
        register: undefined,
        newValue: value
    };
    for (var i = 0; i < this.r.length; i++) {
        if (i.toString() === register) {
            ev.register = i;
            this.r[i] = value;
            notifyListeners(ev);
            return true;
        }
    }
    for (var i = 0; i < this.specialRegisters.length; i++) {
        var name = this.specialRegisters[i];
        if (name === register) {
            ev.register = name;
            this[name] = value;
            notifyListeners(ev);
            return true;
        }
    }
    return false;
}
