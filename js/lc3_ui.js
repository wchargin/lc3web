$(document).ready(function() {
    var lc3 = new LC3();
    window.lc3 = lc3; // for ease of debugging

    // Preload the LC3 (this is for ease of testing only)
    (function() {
        lc3.setLabel(0x3000, 'START');
        lc3.setMemory(0x3000, 0xF020);
        lc3.setMemory(0x3001, 0xF021);
        lc3.setMemory(0x3002, 0x0FFD);
    })();

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
     * This is a set whose keys are addresses and values are the literal true.
     */
    var breakpoints = {};

    /*
     * Different characters to recognize as newlines
     * and map to the user's preferred line terminator.
     */
    var newlines = [0x0A, 0x0D];
    var preferredNewline = 0x0A;

    /*
     * If this is true, the DOM will not update.
     * Use when executing a bunch of instructions;
     * just update once at the end.
     */
    var batchMode = false;

    /*
     * If in batch mode, the subroutine level at which to exit.
     */
    var target = -1;

    /*
     * The value returned by setInterval when entering batch mode.
     */
    var intervalID;
    var intervalDelay = 5; // in milliseconds; constant

    /*
     * A rudimentary lock for synchronizing batch mod calls.
     * The LC-3 should execute far faster than the interval Delay,
     * so this shouldn't matter...but better safe than sorry.
     */
    var lastInstructionComplete;

    /*
     * Standardize a character code (input is integer, not string).
     * Newlines will be converted to the desired format.
     * Other characters will pass through unchanged.
     */
    var standardizeChar = function(key) {
        if (newlines.indexOf(key) === -1) {
            // It's not a newline; let it pass unfiltered.
            return key;
        } else {
            // If we have a preference, force it.
            return preferredNewline !== null ? preferredNewline : key;
        }
    };

    var toggleBreakpoint = function(address) {
        if (address in breakpoints) {
            delete breakpoints[address];
        } else {
            breakpoints[address] = true;
        }
        updateMemoryRow(address);
    };

    /*
     * Callback function invoked when a value is edited by the user,
     * and memory and/or the display should be updated.
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

    var updateBufferCount = function() {
        var count = lc3.bufferedKeys.getLength();
        $('#buffered-char-count').text(count.toString());
        $('#buffered-char-noun').text(count === 1 ? 'character' : 'characters');
    };

    /*
     * Listen for memory changes.
     */
    lc3.addListener(function (ev) {
        if (batchMode && ev.type !== 'keyout') {
            return;
        }
        var type = ev.type;
        if (type === 'memset') {
            var address = ev.address;
            updateMemoryRow(address);
        } else if (type === 'regset') {
            if (ev.register === 'pc') {
                // We might have to change the highlighting of rows.
                refreshMemoryDisplay();
            }
            updateRegister(ev.register);
        } else if (type === 'labelset' || type === 'labelunset') {
            // Easiest to just reset the display.
            refreshMemoryDisplay();
        } else if (type === 'bufferchange') {
            updateBufferCount();
        } else if (type === 'keyout') {
            // Add to the console.
            var $console = $('#console-contents');
            var ch = String.fromCharCode(standardizeChar(ev.value));
            $console.text($console.text() + ch);
        } else {
            // handle this?
        }
    });

    /*
     * Update a single row in memory to reflect changes in the model.
     */
    var updateMemoryRow = function(address) {
        var row = address - currentMemoryLocation;
        if (row < 0 || row >= memoryRows.length) {
            // This row isn't currently displayed.
            return;
        }
        var data = lc3.memory[address];
        var $row = memoryRows[row];

        var $dropdown = $row.find('button.memory-dropdown');
        var $cellAddress = $row.find('span.memory-address');
        var $cellLabel = $row.find('span.memory-label');
        var $cellHex = $row.find('span.memory-hex');
        var $cellInstruction = $row.find('span.memory-instruction');

        $dropdown.data('address', address);
        $cellAddress.text(LC3Util.toHexString(address));
        $cellLabel.text(lc3.addressToLabel[address] || '');
        $cellHex.text(LC3Util.toHexString(data));
        $cellInstruction.text(lc3.instructionAddressToString(address));

        // Highlight the program counter.
        var pcClass = 'btn-primary';
        if (lc3.pc === address) {
            $dropdown.addClass(pcClass);
        } else {
            $dropdown.removeClass(pcClass);
        }

        // Mark breakpoints in red.
        var breakpointClass = 'danger';
        if (address in breakpoints) {
            $row.addClass(breakpointClass);
        } else {
            $row.removeClass(breakpointClass);
        }
    };

    /*
     * Display a block of memory starting at the given location.
     * All rows will be updated.
     */
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

        // Update each row individually.
        for (var i = 0; i < memoryRows.length; i++) {
            var address = i + startPosition;
            var data = lc3.memory[address];
            updateMemoryRow(address);

            // Update the edit linkage.
            var editLinkage = {
                type: 'address',
                address: address,
                name: LC3Util.toHexString(address),
            };
            var $row = memoryRows[i];
            $row.find('.memory-hex').data('edit-linkage', editLinkage);
        }
    };
    /*
     * Refresh the current memory display to reflect any changes.
     */
    var refreshMemoryDisplay = function() {
        displayMemory(currentMemoryLocation);
    };

    /*
     * Scrolls to the PC if it is not already in view.
     */
    var followPC = function() {
        var offset = lc3.pc - currentMemoryLocation;
        if (offset < 0 || offset >= memoryRows.length) {
            // Give a little bit of pre-context
            displayMemory(lc3.pc - memoryRows.length / 4);
        }
    };

    /*
     * Updates the given register display with the new value.
     */
    var updateRegister = function(register) {
            registers[register].text(LC3Util.toHexString(lc3.getRegister(register)));
    };

    var refreshRegisters = function() {
        for (var registerID in registers) {
            updateRegister(registerID);
        }
    };

    /*
     * Enter batch mode. The 'target' variable should already be set.
     */
    var enterBatchMode = function() {
        batchMode = true;

        // Update form controls disabled status.
        $('.disabled-running').prop('disabled', true);
        $('.disabled-paused').prop('disabled', false);

        lastInstructionComplete = true;
        this.intervalID = setInterval(function() {
            if (!lastInstructionComplete) {
                // We'll get it at the next interval.
                return;
            }

            var done = false;
            lastInstructionComplete = false;
            do {
                var op = lc3.nextInstruction();
                if (lc3.subroutineLevel <= target) {
                    // We've reached our target. Exit.
                    done = true;
                    exitBatchMode();
                }
                if (lc3.pc in breakpoints) {
                    // We've hit a breakpoint. Exit.
                    done = true;
                    exitBatchMode();
                }
                if (!lc3.isRunning()) {
                    // We've halted. Exit.
                    done = true;
                    exitBatchMode();
                }
                if (op.isIO) {
                    // This is an IO instruction. Delay (but don't exit).
                    done = true;
                }
            } while (!done);
            lastInstructionComplete = true;
        }, intervalDelay);
    };

    /*
     * Exit batch mode and refresh all displays to account for any changes.
     */
    var exitBatchMode = function() {
        // Update form controls disabled status.
        $('.disabled-running').prop('disabled', false);
        $('.disabled-paused').prop('disabled', true);

        if ($('#follow-pc').prop('checked')) {
            followPC();
        }

        batchMode = false;
        refreshMemoryDisplay();
        refreshRegisters();
        clearInterval(this.intervalID);
    };

    /*
     * Jump to the memory location (or label) listed in the search field.
     * Display an error alert to the user if the location is invalid.
     */
    var performJumpTo = function() {
        var $invalid = $('#error-address-invalid');
        var $bounds = $('#error-address-bounds');

        var text = $('#mem-jumpto').val().trim();
        if (text.length === 0) {
            // Cleared the field; nothing to do.
            $invalid.slideUp();
            $bounds.slideUp();
            return;
        }
        var address = LC3Util.parseNumber(text);

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
                $bounds.slideUp();
                outOfBounds = false;
            } else {
                $bounds.slideDown();
                outOfBounds = true;
            }
        }
        if (isInvalid) {
            $invalid.slideDown();
            $bounds.slideUp();
        } else {
            $invalid.slideUp();
        }
        if (isInvalid || outOfBounds) {
            $('#mem-jumpto-group').addClass('has-error');
        } else {
            $('#mem-jumpto-group').removeClass('has-error');
        }
        $('#mem-jumpto').focus();
    };

    // Set up listeners for memory scrolling controls.
    (function() {
        $('#mem-jumpto-activate').click(function() {
            $('#mem-jumpto').focus();
        });
        $('#mem-jumpto').on('input', performJumpTo);

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

        var $newLabelRow = $('#new-label-row');
        $newLabelRow.find('.error-feedback').hide();
        var $template = $newLabelRow.clone().prop('id', '');
        $newLabelRow.find('button, .label-address').remove();
        var createLabelRow = function(text, address, exists) {
            var $row = $template.clone();
            $row.insertBefore($newLabelRow);

            var $name = $row.find('.label-name');
            var $address = $row.find('.label-address');
            var $remove = $row.find('button');

            $name.val(text).focus();
            $name.data('old-val', text);
            $address.val(address !== null ? LC3Util.toHexString(address) : '');

            // Data linkage (to get around closure semantics)
            var linkage_ = {
                name: $name,
                address: $address,
                remove: $remove,
                hasError: {
                    name: false,
                    address: !exists,
                },
                previous: {
                    exists: exists,
                    labelName: exists ? text : null,
                    labelAddress: exists ? address : null,
                },
            };
            $name.data('linkage', linkage_);
            $address.data('linkage', linkage_);
            $remove.data('linkage', linkage_);

            $name.on('input', function() {
                var linkage = $(this).data('linkage');
                var oldName = $(this).data('old-name');
                var newName = $(this).val().trim();

                var $cell = $(this).closest('td');

                $(this).data('old-name', newName);
                if (oldName === newName) {
                    return;
                }

                var error = false;
                console.log(newName in lc3.labelToAddress);

                var empty = (newName.length === 0);
                var conflict = (newName in lc3.labelToAddress)
                    && (newName !== linkage.previous.labelName);
                error = empty || conflict;
                if (empty) {
                    $cell.find('.name-empty').slideDown();
                } else {
                    $cell.find('.name-empty').slideUp();
                }
                if (conflict) {
                    $cell.find('.name-conflict').slideDown();
                } else {
                    $cell.find('.name-conflict').slideUp();
                }

                if (error) {
                    $cell.addClass('has-error');
                    $cell.find('.name-error').show();
                } else {
                    $cell.removeClass('has-error');
                    $cell.find('.name-error').hide();
                }
                linkage.hasError.name = error;
            });

            $address.on('input', function() {
                var linkage = $(this).data('linkage');
                var num = LC3Util.parseNumber($(this).val());

                var $cell = $(this).closest('td');

                var error = false;
                var invalid = isNaN(num) || num !== LC3Util.toUint16(num);
                var conflict = (num !== linkage.previous.labelAddress && num in lc3.addressToLabel);
                error = invalid || conflict;

                if (invalid) {
                    $cell.find('.address-invalid').slideDown();
                } else {
                    $cell.find('.address-invalid').slideUp();
                }
                if (conflict) {
                    $cell.find('.address-conflict').slideDown();
                } else {
                    $cell.find('.address-conflict').slideUp();
                }

                if (error) {
                    $cell.addClass('has-error');
                    $cell.find('.address-error').show();
                } else {
                    $cell.removeClass('has-error');
                    $cell.find('.address-error').hide();
                }
                linkage.hasError.address = error;
            });

            var update = function() {
                var linkage = $(this).data('linkage');
                if (linkage.hasError.name || linkage.hasError.address) {
                    return;
                }
                var name = linkage.name.val().trim();
                var address = LC3Util.parseNumber(linkage.address.val());
                if (linkage.previous.exists) {
                    lc3.unsetLabelGivenName(linkage.previous.labelName);
                } else {
                    linkage.previous.exists = true;
                }
                lc3.setLabel(address, name);
                linkage.previous.labelName = name;
                linkage.previous.labelAddress = address;
            };
            $name.on('input', update);
            $address.on('input', update);


            $remove.click(function() {
                var linkage = $(this).data('linkage');
                if (linkage.previous.exists !== null) {
                    lc3.unsetLabelGivenName(linkage.previous.labelName);
                }
                $(this).closest('tr').remove();
            });
        };
        $newLabelRow.find('.label-name').on('input', function() {
            createLabelRow($(this).val(), null, false);
            $(this).val('');
        });

        $('#manage-labels-button').click(function() {
            $('#label-manager').modal('show');
        });
        $('#label-manager').on('show.bs.modal', function() {
            // Remove all rows except for the last (the new label row)
            $(this).find('tbody tr:not(:last)').remove();
            // Recreate from memory
            for (name in lc3.labelToAddress) {
                createLabelRow(name, lc3.labelToAddress[name], true);
            }
        });

    })();


    // Add the registers.
    (function() {
        var $registersPrimary = $('#registers-primary');
        for (var i = 0; i < lc3.r.length; i++) {
            var name = 'R' + i;
            var editLinkage = {
                type: 'register',
                register: i,
                name: name,
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
                name: 'the ' + name,
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
    })();

    // Add the memory addresses and set up the memory display.
    (function() {
        var $cellTableBody = $('#memory-table tbody');
        for (var i = 0; i < memoryRows.length; i++) {
            var $row = $('<tr>');
            $row.addClass('memory-cell');

            // First, we have the drop-down menu.
            var $menu = $('<div>')
                .addClass('btn-group dropdown')
                .appendTo($('<td>').appendTo($row).addClass('shrink-to-fit'));
            var $dropdown = $('<button>')
                .addClass('btn btn-default dropdown-toggle memory-dropdown')
                .attr('data-toggle', 'dropdown')
                .append($('<span>').addClass('caret'))
                .appendTo($menu);
            var $dropdownList = $('<ul>')
                .addClass('dropdown-menu')
                .prop('role', 'menu')
                .appendTo($menu);

            // We can't use $dropdown in callbacks because of closure semantics.
            // Attach it to the items instead.
            // This helper function does that (and a bit more).
            var createDropdownItem = function(name) {
                return $('<a>').prop('href', '#').prop('role', 'button')
                        .text(name)
                        .data('dropdown', $dropdown)
                        .appendTo($('<li>').appendTo($dropdownList));
            };

            var $pc;
            var $bp;
            $pc = createDropdownItem('Move PC here').click(function() {
                lc3.setRegister('pc', $(this).data('dropdown').data('address'));
            });
            $bp = createDropdownItem('Set breakpoint here').click(function() {
                toggleBreakpoint($(this).data('dropdown').data('address'));
            }).addClass('breakpoint-toggle');
            // We want to update the breakpoint text when the dropdown activates.
            // (It should be a toggle.)
            $dropdown.click(function() {
                var local$bp = $(this).parent().find('.breakpoint-toggle'); // again, closures
                if ($(this).data('address') in breakpoints) {
                    local$bp.text('Clear this breakpoint');
                } else {
                    local$bp.text('Set breakpoint here');
                }
            });

            // Actual cell text values will be filled in later (updateMemoryRow).
            var createCell = function(classes) {
                return $('<td>').append($('<span>').addClass(classes));
            };

            var address = LC3Util.toHexString(i + currentMemoryLocation);
            $row.append(createCell('memory-address hex-value').addClass('shrink-to-fit'));
            $row.append(createCell('memory-label'));
            $row.append(createCell('memory-hex hex-value hex-signed hex-editable'));
            $row.append(createCell('memory-instruction'));
            $cellTableBody.append($row);
            memoryRows[i] = $row;
        }
        displayMemory(currentMemoryLocation);
    })();

    // Configure the editable hex values.
    $('.hex-editable').popover({
        html: true,
        container: 'body',
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
                         .addClass('hex-value form-control hex-edit-field')
                         .val($(this).text())
                         .appendTo($inputBar);

            // List of errors.
            var $ul =  $('<ul>').appendTo($('<div>').appendTo($container)).addClass('error-list');
            var $msgValid = $('<li>').text('Invalid number').appendTo($ul);

            // Buttons to submit or cancel.
            var $buttons = $('<div>').addClass('btn-group');
            $('<div>').addClass('text-center').append($buttons).appendTo($container);

            var doCancel = function() {
                $oldThis.popover('hide');
            };
            var doSubmit = function() {
                $oldThis.popover('hide');
                var num = LC3Util.toUint16(LC3Util.parseNumber($field.val()));
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
                var num = LC3Util.parseNumber(text);

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
        $('.hex-edit-field').focus().select();
    });

    // Set up hex-value tooltips.
    (function() {
        var hexValueTooltipTitle = function() {
            if ($(this).hasClass('hex-no-tooltip')) {
                return;
            }
            var signed = $(this).hasClass('hex-signed');
            var text = $(this).text() || $(this).val();
            var hex = text.replace(/[^0-9A-Fa-f]/g, '');
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
        $('.hex-value').not('.hex-no-tooltip').tooltip( { title: hexValueTooltipTitle });
    })();

    // Set up execution control buttons.
    (function() {
        $('#control-step').click(function() {
            lc3.nextInstruction();
            if ($('#follow-pc').prop('checked')) {
                followPC();
            }
        });
        $('#control-next').click(function() {
            // Keep going until we get back to this level.
            target = lc3.subroutineLevel;
            enterBatchMode();
        });
        $('#control-continue').click(function() {
            // Machine was paused or hit a breakpoint.
            // Keep the original target level.
            enterBatchMode();
        });
        $('#control-finish').click(function() {
            // Keep going until we go one level up.
            target = lc3.subroutineLevel - 1;
            enterBatchMode();
        });
        $('#control-pause').click(function() {
            exitBatchMode();
        });
        $('#control-buttons button').tooltip();
    })();

    // Set up console for key events and clear buttons.
    (function() {
        $('#console-contents').focus(function() {
            $(this).addClass('bg-info');
        }).blur(function() {
            $(this).removeClass('bg-info');
        }).keypress(function(e) {
            var key = e.which;
            lc3.sendKey(standardizeChar(key));
        });

        $('#btn-clear-in').click(function() {
            lc3.clearBufferedKeys();
        });
        $('#btn-clear-out').click(function() {
            $('#console-contents').text('');
        });

        updateBufferCount();
    })();

    // Link newline radio buttons to model
    (function() {
        $('#newline-select input[type=radio]').change(function() {
            var newline = $(this).data('newline');
            if (newline === 'binary') {
                preferredNewline = null;
            } else {
                preferredNewline = parseInt($(this).data('newline'), 16);
            }
            $('#console-contents').focus();
        });
    })();

    // Upload
    var invokeUploadModal = function(title, callback, extensionWarnings) {
        extensionWarnings = extensionWarnings || {};

        var $modal = $('#load-object');
        var $dropArea = $modal.find('.drop-holder');
        var $dropBox = $modal.find('.drop-box');
        var $warning = $modal.find('.confirm-extension');

        // Reset from any previous invocations
        $dropArea.show();
        $warning.hide();

        // mostly copied from:
        // http://stackoverflow.com/a/6480317/732016
        $dropArea.data('accept-drop', true).bind({
            dragover: function() {
                if ($dropArea.data('accept-drop')) {
                    $dropBox.addClass('hover');
                }
                return false;
            },
            dragend: function() {
                if ($dropArea.data('accept-drop')) {
                    $dropBox.removeClass('hover');
                }
                return false;
            },
            dragleave: function() {
                if ($dropArea.data('accept-drop')) {
                    $dropBox.removeClass('hover');
                }
                return false;
            },
            drop: function(e) {
                if (!$dropArea.data('accept-drop')) {
                    return;
                }
                $dropArea.data('accept-drop', false);
                $dropBox.removeClass('hover');
                e = e || window.event;
                e.preventDefault();
                e = e.originalEvent || e;

                var files = (e.files || e.dataTransfer.files);
                var file = files[0];
                if (!file) {
                    return;
                }

                var filename = file.name;
                var lowercaseName = filename.toLowerCase();
                var warningSuffixes = ['bin', 'hex', 'asm', 'txt'];
                var suffix = lowercaseName.replace(/.*\.([^.]*)/, '$1');
                var warn = false;
                if (extensionWarnings.blacklist) {
                    if (extensionWarnings.blacklist.indexOf(suffix) !== -1) {
                        warn = true;
                    }
                }
                if (extensionWarnings.whitelist) {
                    if (extensionWarnings.whitelist.indexOf(suffix) === -1) {
                        warn = true;
                    }
                }
                if (warn) {
                    $warning.slideDown();
                    $warning.find('#extension-feedback').text(extensionWarnings.feedback || '');
                    $warning.find('#extension-contents').text(suffix.toUpperCase());
                    $warning.find('#extension-confirm').click(function() {
                        $warning.slideUp();
                        $modal.modal('hide');
                        callback(file);
                    });
                    $warning.find('#extension-again').click(function() {
                        $dropArea.data('accept-drop', true);
                        $dropArea.slideDown();
                        $warning.slideUp();
                    });
                } else {
                    $modal.modal('hide');
                    callback(file);
                }
                $dropArea.animate({ height: 'toggle', opacity: 'toggle'});
            }
        });
        $modal.modal();
    };

    // Upload object
    (function() {
        $('#mem-upload-object').click(function() {
            var extensionWarnings = {
                feedback: 'Are you sure it\'s an object file? That is, did you assemble it or convert it from base-2 or hexadecimal ASCII?',
                blacklist: ['bin', 'hex', 'asm', 'txt'],
            };
            invokeUploadModal('Load object file', function(file) {
                var reader = new FileReader();
                reader.onload = function(e) {
                    var dataString = e.target.result;
                    var data = new Array(dataString.length / 2);
                    for (var i = 0; i < data.length; i ++) {
                        var hi = dataString.charCodeAt(2 * i) << 8;
                        var lo = dataString.charCodeAt(2 * i + 1);
                        data[i] = lo | hi;
                    }
                    var orig = data[0];
                    for (var i = 1; i < data.length; i++) {
                        var address = orig + i - 1;
                        var value = data[i];
                        lc3.setMemory(address, value);
                    }
                };
                reader.readAsBinaryString(file);
            }, extensionWarnings);
        });
    })();

    // Activate!
    $('#container-wait').slideUp();
    $('#container-main').fadeIn();
});
