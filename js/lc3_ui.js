$(document).ready(function() {
    var lc3 = new LC3();
    window.lc3 = lc3; // for ease of debugging

    lc3.setLabel(0x3000, 'START');

    /*
     * Address of the top value in the table.
     */
    var currentMemoryLocation = lc3.pc;

    /*
     * Array of the <tr> DOM elements used to display memory.
     */
    var memoryRows = Array(16);

    /*
     * Array mapping register IDs (e.g., 3 or 'pc') to
     * the span.hex-value elements used in their display.
     */
    var registers = {};

    /*
     * Array of the addresses with breakpoints assigned.
     */
    var breakpoints = [];

    /*
     * Different characters to recognize as newlines
     * and map to the user's preferred line terminator.
     */
    var newlines = [0x0A, 0x0D];
    var preferredNewline = 0x0A;

    /*
     * Parses a decimal or hexadecimal value, or returns NaN.
     */
    var parseNumber = function(value) {
        value = value.toLowerCase();
        if (value.length == 0) {
            return NaN;
        }
        var negative = false;
        if (value[0] === '-') {
            value = value.slice(1);
            negative = true;
        }
        if (value[0] === 'x') {
            var hexDigits = value.slice(1);
            if (hexDigits.match(/[^0-9a-f]/)) {
                return NaN;
            }
            var num = parseInt(hexDigits, 16);
            return negative ? -num : num;
        } else {
            if (value.match(/[^0-9]/)) {
                return NaN;
            }
            var num = parseInt(value);
            return negative ? -num : num;
        }
    };

    /*
     * Gets the tooltip text for $(this), a .hex-value item.
     */
    var hexValueTooltipTitle = function() {
        if ($(this).hasClass('hex-no-tooltip')) {
            return;
        }
        var signed = $(this).hasClass('hex-signed');
        var hex = $(this).text().replace(/[^0-9A-Fa-f]/g, '');
        var num = parseInt("0x" + hex);
        if (signed) {
            num = LC3Util.toInt16(num);
        }
        var numString = num.toString().replace('-', '\u2212');
        var prefix = 'decimal ';
        var suffix = signed ? ' (signed)' : ' (unsigned)';
        var titleText = prefix + numString + suffix;
        return titleText;
    };

    /*
     *
     */
    var updateValue = function(linkage, value) {
        var type = linkage.type;
        if (type === 'address') {
            var address = linkage.address;
            lc3.setMemory(address, value);
        } else if (type === 'register') {
            var register = linkage.register;
            lc3.setRegister(register, value);
        } else {
            throw new Error("Unknown linkage type: " + type);
        }
    };

    /*
     * Listen for memory changes.
     */
    lc3.addListener(function (ev) {
        var type = ev.type;
        if (type === 'memset') {
            var address = ev.address;
            var index = address - currentMemoryLocation;
            if (0 <= index && index < memoryRows.length) {
                var $row = memoryRows[index];
                $row.find('.memory-hex').text(LC3Util.toHexString(ev.newValue));
                $row.find('.memory-instruction').text(lc3.instructionAddressToString(address));
            }
        } else if (type === 'regset') {
            if (ev.register === 'pc') {
                // We might have to change the highlighting of rows.
                refreshMemoryDisplay();
            }
            registers[ev.register].text(LC3Util.toHexString(ev.newValue));
        } else if (type === 'labelset' || type === 'labelunset') {
            // Easiest to just reset the display.
            refreshMemoryDisplay();
        } else {
            // handle this?
        }
    });

    // Add the registers
    var $registersPrimary = $('#registers-primary');
    for (var i = 0; i < lc3.r.length; i++) {
        var name = 'R' + i;
        var editLinkage = {
            type: 'register',
            register: i,
            name: name
        };
        var $row = $('<div>')
            .addClass('col-xs-6 col-sm-3');
        var $name = $('<span>')
            .addClass('register-name')
            .text(name);
        var $value = $('<span>')
            .addClass('register-value hex-value hex-signed hex-editable')
            .text(LC3Util.toHexString(lc3.getRegister(i)))
            .data('edit-linkage', editLinkage);
        $row.append($name).append(': ').append($value);
        $registersPrimary.append($row);
        registers[i] = $value;
    }
    var $registersSpecial = $('#registers-special');
    for (var i = 0; i < lc3.specialRegisters.length; i++) {
        var register = lc3.specialRegisters[i];
        var name = register.toUpperCase();
        var editLinkage = {
            type: 'register',
            register: register,
            name: name
        };
        var $row = $('<div>')
            .addClass('col-xs-12 col-sm-3');
        var $name = $('<span>')
            .addClass('register-name')
            .text(name);
        var $value = $('<span>')
            // note: special registers are unsigned
            .addClass('register-value hex-value hex-editable')
            .text(LC3Util.toHexString(lc3.getRegister(register)))
            .data('edit-linkage', editLinkage);
        $row.append($name).append(': ').append($value);
        $registersSpecial.append($row);
        registers[register] = $value;
    }

    // Add the memory addresses
    var $cellTableBody = $('#memory-table tbody');
    for (var i = 0; i < memoryRows.length; i++) {
        var $row = $('<tr>');
        $row.addClass('memory-cell');
        var createCell = function(classes, value) {
            var $cell = $('<td>');
            var $contents = $('<span>');
            for (var j = 0; j < classes.length; j++)
            {
                $contents.addClass(classes[j]);
            }
            $contents.text(value);
            $cell.append($contents);
            return $cell;
        };
        $row.append(createCell(['memory-address', 'hex-value'], LC3Util.toHexString(i + 0x3000)));
        $row.append(createCell(['memory-label'], ''));
        $row.append(createCell(['memory-hex', 'hex-value', 'hex-signed', 'hex-editable'], 'x0000'));
        $row.append(createCell(['memory-instruction'], 'NOP'));
        $cellTableBody.append($row);
        memoryRows[i] = $row;
    }

    var displayMemory = function(startPosition) {
        // If the user inputs, e.g., 0xFFFF, that's a valid value,
        // but the remaining fifteen would not be. Clamp them out.
        var max = lc3.memory.length - memoryRows.length;
        if (startPosition >= max) {
            startPosition = max;
            $('#mem-scroll-down').prop('disabled', true);
        } else {
            $('#mem-scroll-down').prop('disabled', false);
        }
        if (startPosition <= 0) {
            startPosition = 0;
            $('#mem-scroll-up').prop('disabled', true);
        } else {
            $('#mem-scroll-up').prop('disabled', false);
        }
        currentMemoryLocation = startPosition;

        for (var i = 0; i < memoryRows.length; i++) {
            var address = i + startPosition;
            var data = lc3.getMemory(address);
            var $row = memoryRows[i];

            var cellAddress = $row.find('span.memory-address');
            var cellLabel = $row.find('span.memory-label');
            var cellHex = $row.find('span.memory-hex');
            var cellInstruction = $row.find('span.memory-instruction');

            cellAddress.text(LC3Util.toHexString(address));
            cellLabel.text(lc3.addressToLabel[address] || '');
            cellHex.text(LC3Util.toHexString(data));
            cellInstruction.text(lc3.instructionAddressToString(address));

            var editLinkage = {
                type: 'address',
                address: address,
                name: LC3Util.toHexString(address),
            };
            cellHex.data('edit-linkage', editLinkage);

            if (lc3.pc === address) {
                $row.addClass('active');
            } else {
                $row.removeClass('active');
            }
            if (breakpoints.indexOf(address) !== -1) {
                $row.addClass('danger');
            } else {
                $row.removeClass('danger');
            }
        }
    };
    var refreshMemoryDisplay = function() {
        displayMemory(currentMemoryLocation);
    };
    lc3.memory[0x3000] = 0x5260;
    lc3.memory[0x3001] = 0x5920;
    lc3.memory[0x3002] = 0x192A;
    lc3.memory[0x3003] = 0xE4FC;
    lc3.memory[0x3004] = 0x6680;
    lc3.memory[0x3005] = 0x14A1;
    lc3.memory[0x3006] = 0x1243;
    lc3.memory[0x3007] = 0x193F;
    lc3.memory[0x3008] = 0x03FB;
    lc3.memory[0x3009] = 0xF025;
    lc3.setRegister(0, 42);
    lc3.setRegister(1, 68);

    $(".hex-value").each(function() {
        var $el = $(this);
    });
    displayMemory(currentMemoryLocation);

    var performJumpTo = function() {
        var invalid = $('#error-address-invalid');
        var bounds = $('#error-address-bounds');

        var text = $('#mem-jumpto').val().trim();
        if (text.length === 0) {
            // Cleared the field; nothing to do.
            invalid.slideUp();
            bounds.slideUp();
            return;
        }
        var address = parseNumber(text);

        var isInvalid = false;
        var outOfBounds = false;
        if (isNaN(address)) {
            // Perhaps it's the name of a label?
            var labelAddress = lc3.labelToAddress[text];
            if (labelAddress !== undefined) {
                displayMemory(labelAddress);
            }
            // Maybe they're about to enter a hex address?
            else if (text.toLowerCase() === 'x') {
                // Nothing to do, in that case. Wait patiently.
            } else {
                isInvalid = true;
            }
        } else {
            isInvalid = false;
            if (address < lc3.memory.length) {
                displayMemory(address);
                bounds.slideUp();
                outOfBounds = false;
            } else {
                bounds.slideDown();
                outOfBounds = true;
            }
        }
        if (isInvalid) {
            invalid.slideDown();
            bounds.slideUp();
        } else {
            invalid.slideUp();
        }
        if (isInvalid || outOfBounds) {
            $('#mem-jumpto-group').addClass('has-error');
        } else {
            $('#mem-jumpto-group').removeClass('has-error');
        }
        $('#mem-jumpto').focus();
    };
    $('#mem-jumpto-activate').click(function() {
        $('#mem-jumpto').focus();
    });
    $('#mem-jumpto').on('input', performJumpTo);
    $('#mem-jumpto-go').click(performJumpTo);

    $('#mem-jump-pc').click(function() {
        displayMemory(lc3.pc);
        $(this).blur();
    });
    $('#mem-scroll-up').click(function() {
        displayMemory(currentMemoryLocation - 1);
        $(this).blur();
    });
    $('#mem-scroll-down').click(function() {
        displayMemory(currentMemoryLocation + 1);
        $(this).blur();
    });

    $('.hex-editable').popover({
        html: true,
        title: function() {
            return 'Edit value of ' + $(this).data('edit-linkage').name;
        },
        content: function() {
            var $oldThis = $(this);
            var linkage = $(this).data('edit-linkage');

            // Create a little form for the popover content
            var $container = $('<div>').addClass('hex-edit-popover');

            // Input bar contains the text field and status indicator.
            var $inputBar = $('<div>').addClass('input-group').appendTo($container);
            var $icon = $('<span>').addClass('glyphicon glyphicon-pencil');
            var $iconSpan = $('<span>')
                            .addClass('input-group-addon')
                            .append($icon)
                            .appendTo($inputBar);
            var $field = $('<input>')
                         .prop('type', 'text')
                         .addClass('hex-value')
                         .addClass('form-control')
                         .val($(this).text())
                         .appendTo($inputBar);

            // List of errors.
            var $ul =  $('<ul>').appendTo($('<div>').appendTo($container));
            var $msgValid = $('<li>').text('Invalid number').appendTo($ul);

            // Buttons to submit or cancel.
            var $buttons = $('<div>').addClass('btn-group');
            $('<div>').addClass('text-center').append($buttons).appendTo($container);

            var doCancel = function() {
                $oldThis.popover('hide');
            };
            var doSubmit = function() {
                $oldThis.popover('hide');
                var num = LC3Util.toUint16(parseNumber($field.val()));
                updateValue(linkage, num);
            };

            var $cancel = $('<button>').addClass('btn').appendTo($buttons)
                .append($('<span>').addClass('glyphicon glyphicon-remove'))
                .click(doCancel);
            var $submit = $('<button>').addClass('btn btn-primary').appendTo($buttons)
                .append($('<span>').addClass('glyphicon glyphicon-ok'))
                .click(doSubmit);

            // Handler to validate when changed
            $field.on('input', function() {
                var text = $(this).val();
                var num = parseNumber(text);

                // Determine: number valid?
                var valid = !isNaN(num);
                num = LC3Util.toUint16(num);

                // Update (show/hide) error messages
                if (!valid) {
                    $msgValid.slideDown('fast');
                } else {
                    $msgValid.slideUp('fast');
                }

                // Update field highlighting
                if (valid) {
                    $inputBar.removeClass('has-error');
                } else {
                    $inputBar.addClass('has-error');
                }

                // Update status indicator
                var goodClass = 'glyphicon-pencil';
                var badClass = 'glyphicon-exclamation-sign';
                $icon.addClass(valid ? goodClass : badClass);
                $icon.removeClass(valid ? badClass : goodClass);

                // Update submit button
                $submit.prop('disabled', !valid);
            }).keydown(function(e) {
                if (e.keyCode === 13) { // Enter
                    $submit.click();
                }
            });

            return $container;
        },
        trigger: 'click'
    }).on('shown.bs.popover', function() {
        // Focus input field when the popup is ready.
        // The DOM created is like this:
        //   <span class=".hex-editable ...">$(this);</span>
        //   <div class="popover...">...<input...></div>
        // so we can use a plus-selector to find the input.
        $(this).find('+ div input').focus();
    });

    $('.hex-value').tooltip( { title: hexValueTooltipTitle });

    $('#control-step').click(function() { lc3.nextInstruction(); });

    $('#console-contents').focus(function() {
        $(this).addClass('bg-info');
    }).blur(function() {
        $(this).removeClass('bg-info');
    }).keypress(function(e) {
        var key = e.which;
        if (newlines.indexOf(key) !== -1) {
            key = preferredNewline;
        }
        console.log(key);
    });

    $('#newline-0a, #newline-0d').change(function() {
        preferredNewline = parseInt($(this).data('newline'), 16);
        $('#console-contents').focus();
    });
    $('#newline-0a').change();


    $('#container-wait').slideUp();
    $('#container-main').fadeIn();
});
