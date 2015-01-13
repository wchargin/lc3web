$(document).ready(function() {
    var lc3 = new LC3();
    window.lc3 = lc3; // for ease of debugging

    /*
     * Address of the top value in the table.
     */
    var currentMemoryLocation = lc3.pc;

    /*
     * Array of the <tr> DOM elements used to display memory.
     */
    var memoryRows = Array(16);

    /*
     * Array of the addresses with breakpoints assigned.
     */
    var breakpoints = [];

    /*
     * Converts a number to a four-digit hexadecimal string with 'x' prefix.
     */
    var toHexString = function(value) {
        var hex = value.toString(16).toUpperCase();
        var padLength = 4;
        if (hex.length < padLength) {
            hex = (Array(padLength - hex.length + 1).join('0')) + hex;
        }
        return 'x' + hex;
    };

    /*
     * Parses a decimal or hexadecimal value, or returns NaN.
     */
    var parseNumber = function(value) {
        value = value.toLowerCase();
        if (value.length == 0) {
            return NaN;
        }
        if (value[0] === 'x') {
            var hexDigits = value.slice(1);
            if (hexDigits.match(/[^0-9a-f]/)) {
                return NaN;
            }
            return parseInt(hexDigits, 16);
        } else {
            if (value.match(/[^0-9]/)) {
                return NaN;
            }
            return parseInt(value);
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
            num = toInt16(num);
        }
        var numString = num.toString().replace('-', '\u2212');
        var titleText = "decimal " + numString;
        return titleText;
    };

    /*
     *
     */
    var updateValue = function($el, value) {
        var linkage = $el.data('edit-linkage');
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
                $row.find('.memory-hex').text(toHexString(ev.newValue));
            }
        } else if (type === 'regset') {
        } else {
            // handle this?
        }
    });

    // Add the memory addresses
    var $cellTableBody = $('#memory-table tbody');
    for (var i = 0; i < memoryRows.length; i++) {
        var $row = $('<tr>');
        $row.addClass('memory-cell');
        $row.attr('data-cell-number', i.toString());
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
        $row.append(createCell(['memory-address', 'hex-value'], toHexString(i + 0x3000)));
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

            cellAddress.text(toHexString(address));
            cellLabel.text('TODO');
            cellHex.text(toHexString(data));
            cellInstruction.text('TODO');

            var editLinkage = {
                type: 'address',
                address: address,
            };
            cellHex.data('edit-linkage', editLinkage);

            if (lc3.pc === address) {
                $row.addClass('address-pc');
            } else {
                $row.removeClass('address-pc');
            }
            if (breakpoints.indexOf(address) !== -1) {
                $row.addClass('address-breakpoint');
            } else {
                $row.removeClass('address-breakpoint');
            }
        }
    };
    lc3.memory[0x3001] = 0xFFFF;

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

        if (!isNaN(address)) {
            invalid.slideUp();
            if (address < lc3.memory.length) {
                displayMemory(address);
                bounds.slideUp();
            } else {
                bounds.slideDown();
            }
        } else {
            // Don't complain if they're about to enter a hex address.
            if (text.toLowerCase() !== 'x') {
                invalid.slideDown();
            }
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
        title: 'Edit value',
        content: function() {
            var $oldThis = $(this);

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
            var $msgRange = $('<li>').text('Value out of range').appendTo($ul);

            // Buttons to submit or cancel.
            var $buttons = $('<div>').addClass('btn-group');
            $('<div>').addClass('text-center').append($buttons).appendTo($container);
            var $cancel = $('<button>').addClass('btn').appendTo($buttons)
                .append($('<span>').addClass('glyphicon glyphicon-remove'))
                .click(function() {
                    $oldThis.popover('hide');
                });
            var $submit = $('<button>').addClass('btn btn-primary').appendTo($buttons)
                .append($('<span>').addClass('glyphicon glyphicon-ok'))
                .click(function() {
                    $oldThis.popover('hide');
                    updateValue($oldThis, parseNumber($field.val()));
                });

            // Handler to validate when changed
            $field.on('input', function() {
                var text = $(this).val();
                var num = parseNumber(text);

                // Determine: number valid? number within valid range?
                var valid = !isNaN(num);
                var inRange = num < 0x10000 && num >= 0;
                var okay = valid && inRange;

                // Update (show/hide) error messages
                if (!valid) {
                    $msgValid.slideDown('fast');
                } else {
                    $msgValid.slideUp('fast');
                }
                if (valid && !inRange) {
                    $msgRange.slideDown('fast');
                } else {
                    $msgRange.slideUp('fast');
                }

                // Update status indicator
                var goodClass = 'glyphicon-pencil';
                var badClass = 'glyphicon-exclamation-sign';
                $icon.addClass(okay ? goodClass : badClass);
                $icon.removeClass(okay ? badClass : goodClass);

                // Update submit button
                $submit.prop('disabled', !okay);
            });

            return $container;
        },
        trigger: 'click'
    });

    $('.hex-value').tooltip( { title: hexValueTooltipTitle });

    $('#container-wait').slideUp();
    $('#container-main').fadeIn();
});
