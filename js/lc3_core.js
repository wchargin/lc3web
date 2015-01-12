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

    // Create and initialize standard registers (R0 to R7)
    this.r = new Array(8);
    for (var i = 0; i < this.r.length; i++) {
        this.r[i] = 0;
    }

    // Initialize special registers
    this.pc = 0x3000;
    this.ir = 0;
    this.psr = 0x0400;

    this.labels = [];

    // Exclusive upper bound for normal memory
    // Memory address 0xFE00 and up are mapped to devices
    this.maxStandardMemory = 0xFE00;

    this.mappedIO = {
        kbsr: 0,
        kbdr: 0,
        dsr: 0,
        ddr: 0,
        mcr: 0x7FFF
    };
    this.mappedAddresses = {
        0xFE00: 'kbsr',
        0xFE02: 'kbdr',
        0xFE04: 'dsr',
        0xFE06: 'ddr',
        0xFFFE: 'mcr'
    };

    // Functions to get and set memory, handling mapped memory edge cases
    this.getMemory = function(address) {
        if (address < this.maxStandardMemory) {
            return this.memory[address];
        }
        var mappedAddress = this.mappedAddresses[address];
        if (mappedAddress !== undefined) {
            return this.mappedIO[mappedAddress];
        }
        return 0;
    }
    this.setMemory = function(address, data) {
        if (address < this.maxStandardMemory) {
            this.memory[address] = data;
            return true;
        }
        var mappedAddress = this.mappedAddresses[address];
        if (mappedAddress !== undefined) {
            this.mappedIO[mappedAddress] = data;
            return true;
        }
        return false;
    }
};
