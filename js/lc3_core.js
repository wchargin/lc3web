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

    // Functions to get and set memory, handling mapped memory edge cases
    this.getMemory = function(address) {
        return this.memory[address];
    }
    this.setMemory = function(address, data) {
        var ev = {
            type: 'memset',
            address: address,
            newValue: data
        };
        this.memory[address] = data;
        this.notifyListeners(ev);
    }

    // Functions to get and set registers (standard or special)
    this.getRegister = function(register) {
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
    this.setRegister = function(register, value) {
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

};
