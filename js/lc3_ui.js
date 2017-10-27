$(document).ready(function() {
    var lc3 = new LC3();
    window.lc3 = lc3; // for ease of debugging

    /**
     * Trigger a download of the provided byte array.
     * This is a compatibility bridge.
     */
    function doDownload(bytes) {
        // The former works in all browsers,
        // but doesn't let us specify the file name,
        // so you get some kind of UUID instead of "symbols_<timestamp>.sym."
        // The latter lacks Firefox support.
        if (true) {
            downloadViaBlob(bytes);
        } else {
            downloadViaAnchorTag(bytes);
        }
    }

    /**
     * Download the provided byte array by triggering an <a download="...">.
     * Works great in Chrome, and lets you specify the file name, too.
     * Doesn't work in Firefox.
     */
    function downloadViaAnchorTag(bytes) {
        var encodedParts = new Array(bytes.length);
        for (var i = 0; i < bytes.length; i++) {
            var b = bytes[i];
            encodedParts[i] = (b < 0x10 ? '%0' : '%') + b.toString(16);
        }
        var encoded = encodedParts.join('');
        var uri = 'data:application/octet-stream,' + encoded;
        $('<a>').attr('href', uri).prop('download', 'output')[0].click();
    }

    /**
     * Download the provided byte array using the Blob API.
     * Seems to work in both Firefox and Chrome,
     * but doesn't let you specify the file name
     * (gives some kind of UUID instead).
     */
    function downloadViaBlob(bytes) {
        var blob = new Blob([bytes], { type: 'application/octet-stream' });
        var url = URL.createObjectURL(blob);
        window.location = url;
    }

    /**
     * Convert an array of words to an array of bytes.
     * The resulting array will have twice the length of the input array.
     */
    function wordsToBytes(words) {
        var arr = new Uint8Array(2 * words.length);
        for (var i = 0; i < words.length; i++) {
            var word = words[i];
            var byte1 = (word >> 8) & 0xFF;
            var byte2 = word & 0xFF;
            arr[2 * i] = byte1;
            arr[2 * i + 1] = byte2;
        }
        return arr;
    }

    /**
     * Convert a string to an array of bytes.
     */
    function stringToBytes(str) {
        var arr = new Uint8Array(str.length);
        for (var i = 0; i < str.length; i++) {
            arr[i] = str.charCodeAt(i);
        }
        return arr;
    }

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
     * Send a tracking event to Google Analytics.
     * Don't worry---this doesn't track any personal information!
     * It just gets information about, e.g.,
     * how many times people click "Assemble," etc.
     */
    var sendEvent = function(category, action, label) {
        if (window.ga) {
            window.ga('send', 'event', category, action, label);
        }
    };
    if (window.ga) {
        var path = window.location.pathname + window.location.hash;
        window.ga('send', 'pageview', path);
    }

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
        var type = ev.type;
        if (batchMode) {
            // Skip events that massively update the DOM and cause lag.
            // Keep the I/O events, though.
            if (type === 'memset' || type === 'regset') {
                return;
            }
        }
        if (type === 'memset') {
            var address = ev.address;
            updateMemoryRow(address);
        } else if (type === 'regset') {
            if (ev.register === 'pc') {
                // We might have to change the highlighting of rows.
                refreshMemoryDisplay();
                if ($('#follow-pc').prop('checked')) {
                    followPC();
                }
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
            // Scroll to the bottom.
            $console.prop('scrollTop', $console.prop('scrollHeight'));
        } else if (type === 'exception') {
            $('.exception[data-exception=' + ev.exception + ']').slideDown();
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
        if (lc3.pc === address && !batchMode) {
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
        if (batchMode) {
            $('#memory-table').addClass('disabled');
        } else {
            $('#memory-table').removeClass('disabled');
        }
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
        var $register = registers[register];
        if (register === 'cc') {
            $register.text(lc3.formatConditionCode());
        } else {
            $register.text(LC3Util.toHexString(lc3.getRegister(register)));
        }
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
        updateButtons();
        // Refresh display to hide the PC.
        refreshMemoryDisplay();

        lastInstructionComplete = true;
        intervalID = setInterval(function() {
            if (!lastInstructionComplete) {
                // We'll get it at the next interval.
                return;
            }

            // We stop executing instructions when
            //   (a) we hit an I/O instruction, or
            //   (b) we process 4096 instructions in a row.
            // This prevents infinite loops from hogging the host CPU.
            var instructionsLeft = 0x1000;

            // Also, don't run at all if the LC-3 is halted.
            var done = !lc3.isRunning();

            lastInstructionComplete = false;
            while (!done) {
                instructionsLeft--;
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
                if (instructionsLeft <= 0) {
                    // Delay (but don't exit) in case we have an infinite loop.
                    done = true;
                }
            }
            lastInstructionComplete = true;
        }, intervalDelay);
    };

    /*
     * Exit batch mode and refresh all displays to account for any changes.
     */
    var exitBatchMode = function() {
        batchMode = false;

        refreshMemoryDisplay();
        refreshRegisters();
        clearInterval(intervalID);
        if ($('#follow-pc').prop('checked')) {
            followPC();
        }

        // Update form controls disabled status.
        updateButtons();
    };

    /*
     * Updates the 'disabled' state of dynamically disabled (.dyndis) buttons.
     */
    var updateButtons = function() {
        var running = batchMode;
        var halted = !lc3.isRunning();
        $('.dyndis').each(function() {
            var disabled = false;
            var $this = $(this);
            if ($this.hasClass('disabled-running')) {
                disabled |= running;
            }
            if ($this.hasClass('disabled-paused')) {
                disabled |= !running;
            }
            if ($this.hasClass('disabled-halted')) {
                disabled |= halted;
            }
            if ($this.hasClass('disabled-unhalted')) {
                disabled |= !halted;
            }
            $this.prop('disabled', disabled);
        });
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
        $('#mem-jumpto').on('keypress', function (e) {
            if (e.keyCode === 13) {  // Enter
                performJumpTo();
            }
        });

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
                var newName = $(this).val();

                var $cell = $(this).closest('td');

                $(this).data('old-name', newName);
                if (oldName === newName) {
                    return;
                }

                var error = false;

                var empty = (newName.length === 0);
                var conflict = (newName in lc3.labelToAddress)
                    && (newName !== linkage.previous.labelName);
                var invalid = newName.match(/[^A-Za-z0-9_]/)
                    || !isNaN(LC3Util.parseNumber(newName));
                error = empty || conflict || invalid;
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
                if (invalid) {
                    $cell.find('.name-invalid').slideDown();
                } else {
                    $cell.find('.name-invalid').slideUp();
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
                var name = linkage.name.val();
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
            sendEvent('labels', 'open_labels_modal');
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

        // Condition codes are even more special
        var $row = $('<div>')
            .addClass('col-xs-12 col-sm-3');
        var $name = $('<span>')
            .addClass('register-name')
            .text("CC");
        var $value = $('<span>')
            .addClass('register-value hex-no-tooltip')
            .text(lc3.formatConditionCode());
        $row.append($name).append(': ').append($value);
        $registersSpecial.append($row);
        registers['cc'] = $value;
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
                refreshRegisters();
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

    // Set up register-reset buttons
    (function() {
        $('#reset-numeric').click(function() {
            lc3.resetNumericRegisters();
            refreshRegisters();
            sendEvent('controls', 'reset_numeric');
        });
        $('#reset-registers').click(function() {
            lc3.resetAllRegisters();
            refreshRegisters();
            refreshMemoryDisplay();
            if ($('#follow-pc').prop('checked')) {
                followPC();
            }
            sendEvent('controls', 'reset_registers');
        });
    })();

    // Set up execution control buttons.
    (function() {
        $('#control-step').click(function() {
            lc3.nextInstruction();
            if ($('#follow-pc').prop('checked')) {
                followPC();
            }
            updateButtons();
            refreshRegisters();
            sendEvent('controls', 'controls_step');
        });
        $('#control-next').click(function() {
            // Keep going until we get back to this level.
            target = lc3.subroutineLevel;
            enterBatchMode();
            sendEvent('controls', 'controls_next');
        });
        $('#control-continue').click(function() {
            // Machine was paused or hit a breakpoint.
            // Keep the original target level.
            enterBatchMode();
            sendEvent('controls', 'controls_continue');
        });
        $('#control-finish').click(function() {
            // Keep going until we go one level up.
            target = lc3.subroutineLevel - 1;
            enterBatchMode();
            sendEvent('controls', 'controls_finish');
        });
        $('#control-run').click(function() {
            // Keep going forever.
            // -1 isn't good enough:
            // if there are more RETs than JSR/JSRR/TRAPs,
            // which can happen if the PC is modified manually
            // or execution flows into a subroutine,
            // then the subroutine level can be negative.
            // But it can't be less than -Infinity!
            // (at least, it would take a while)
            target = -Infinity;
            enterBatchMode();
            sendEvent('controls', 'controls_run');
        });
        $('#control-pause').click(function() {
            exitBatchMode();
            sendEvent('controls', 'controls_pause');
        });
        $('#control-unhalt').click(function() {
            lc3.unhalt();
            $('.exception').slideUp();
            updateButtons();
            refreshRegisters();
            sendEvent('controls', 'controls_unhalt');
        });
        $('#control-buttons button').tooltip();
        updateButtons();
    })();

    // Set up console for key events and clear buttons.
    (function() {
        $('#console-contents').focus(function() {
            $(this).addClass('bg-info');
        }).blur(function() {
            $(this).removeClass('bg-info');
        })
        // IE does weird stuff with ignoring some keypress events.
        // To work around, we handle <Enter> separately, in keydown.
        .keypress(function(e) {
            var key = e.which;
            if (newlines.indexOf(key) !== -1) {
                // Newlines handled in keydown
                return;
            }
            lc3.sendKey(standardizeChar(key));
        }).keydown(function(e) {
            var key = e.which;
            if (newlines.indexOf(key) === -1) {
                // Non-newlines handled in keypress
                return;
            }
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

    // Configure the upload modal
    (function() {
        var importObj = function(file) {
            var reader = new FileReader();
            reader.onload = function(e) {
                // Use a Uint16Array has platform-dependent endianness (!!!).
                // Must manually use a Uint8Array to force little-endian.
                var raw = new Uint8Array(e.target.result);
                var data = new Array(raw.length / 2);
                for (var i = 0; i < data.length; i ++) {
                    var lo = raw[2 * i + 1];
                    var hi = raw[2 * i] << 8;
                    data[i] = lo | hi;
                }
                var orig = data[0];
                for (var i = 1; i < data.length; i++) {
                    var address = orig + i - 1;
                    var value = data[i];
                    lc3.setMemory(address, value);
                }
                lc3.setRegister('pc', orig);
            };
            reader.readAsArrayBuffer(file);
        };
        var importSym = function(file) {
            var reader = new FileReader();
            reader.onload = function(e) {
                var dataString = e.target.result;
                var lines = dataString.split(/[\r\n]/);
                for (var i = 0; i < lines.length; i++) {
                    var line = lines[i];
                    var regex = /.*?([A-Za-z0-9]+)\s*([0-9A-Fa-f]+)/;
                    var match = line.match(regex);
                    if (!match) {
                        continue;
                    }
                    var address = parseInt(match[2], 16);
                    var label = match[1];
                    lc3.setLabel(address, label);
                }
            };
            reader.readAsText(file);
        };
        var extensionData = {
            whitelist: {
                'obj': importObj,
                'sym': importSym,
            },
            blacklist: {
                'bin': '(convert to object file first)',
                'hex': '(convert to object file first)',
                'asm': '(assemble first)',
            },
        };

        var $modal = $('#load-object');
        var $dropArea = $modal.find('.modal-body');
        var $dropBox = $modal.find('.drop-box');
        var $invalid = $modal.find('#invalid-alert');
        var $invalidList = $invalid.find('ul');
        var $success = $modal.find('#confirm-alert');
        var $successList = $success.find('ul');
        var $progress = $modal.find('#upload-in-progress');

        // Maps extensions to lists of files. For example:
        // { 'obj': [<file foo.obj>, <file bar.obj>], 'sym': [<file baz.sym>] }
        var filesToProcess = {};

        // Flat set of files (keys, mapped to true).
        var existingFiles = {};

        // mostly copied from:
        // http://stackoverflow.com/a/6480317/732016
        $dropArea.bind({
            dragover: function() {
                $dropBox.addClass('hover');
                return false;
            },
            dragend: function() {
                $dropBox.removeClass('hover');
                return false;
            },
            dragleave: function() {
                $dropBox.removeClass('hover');
                return false;
            },
            drop: function(e) {
                $dropBox.removeClass('hover');
                e = e || window.event;
                e.preventDefault();
                e = e.originalEvent || e;

                var files = (e.files || e.dataTransfer.files);
                if (!files) {
                    return;
                }

                for (var i = 0; i < files.length; i++) {
                    var file = files[i];
                    var filename = file.name;
                    if (filename in existingFiles) {
                        continue;
                    }

                    var lowercaseName = filename.toLowerCase();
                    var suffix = lowercaseName.replace(/.*\.([^.]*)/, '$1');

                    var invalid = false;
                    var invalidMessage = null;
                    if (suffix in extensionData.blacklist) {
                        invalid = true;
                        invalidMessage = extensionData.blacklist[suffix];
                    } else if (!(suffix in extensionData.whitelist)) {
                        invalid = true;
                        invalidMessage = '(file extension not recognized)';
                    }
                    if (invalid) {
                        var $li = $('<li>')
                            .append($('<strong>').text(filename || ''))
                            .append(' ')
                            .append($('<span>').text(invalidMessage || ''))
                            .data('file-id', file)
                            .appendTo($invalidList);
                        $invalid.slideDown();
                        $invalid.find('#warning-file-noun').text(
                                $invalidList.find('li').length === 1 ? 'file' : 'files');
                    } else {
                        var $li = $('<li>')
                            .append($('<strong>').text(filename || ''))
                            .appendTo($successList);
                        $success.slideDown();
                        var successOne = $successList.find('li').length === 1;
                        $success.find('#success-file-noun').text(successOne ? 'file' : 'files');
                        $success.find('#success-file-verb').text(successOne ? 'is' : 'are');

                        var list = filesToProcess[suffix] || [];
                        list.push(file);
                        filesToProcess[suffix] = list;
                        existingFiles[filename] = true;
                    }
                }
            }
        });
        $invalid.find('#invalid-dismiss').click(function() {
            $invalid.slideUp(function() {
                $invalidList.empty();
            });
        });
        $invalid.find('#invalid-open-assembler').click(function() {
            $modal.modal('hide');
            $('#assemble-modal').modal('show');
        });
        $('#success-confirm').click(function() {
            $dropArea.slideUp();
            $invalid.slideUp();
            $success.slideUp();
            $progress.slideDown();

            var $bar = $progress.find('.progress-bar');
            $bar.addClass('active');
            $bar.css('width', 0);

            $bar.addClass('progress-bar-info');
            $bar.removeClass('progress-bar-success');
            $bar.addClass('progress-bar-striped');

            var done = 0;
            var count = 0;
            for (var type in filesToProcess) {
                count += filesToProcess[type].length;
            }

            for (var type in filesToProcess) {
                var files = filesToProcess[type];
                var callback = extensionData.whitelist[type];
                for (var i = 0; i < files.length; i++) {
                    callback(files[i]);
                }
                done++;
                $bar.css('width', 100 * done / count + '%');
            }

            $bar.removeClass('active');
            $bar.addClass('progress-bar-success');
            $bar.removeClass('progress-bar-info');
            $bar.removeClass('progress-bar-striped');
            $modal.modal('hide');
        });
        $modal.on('show.bs.modal', function() {
            filesToProcess = {};
            existingFiles = {};
            $dropArea.show();
            $invalid.hide();
            $invalidList.empty();
            $success.hide();
            $successList.empty();
            $progress.hide();
        });
    })();

    // Upload object
    (function() {
        $('#mem-upload-object').click(function() {
            sendEvent('upload', 'open_upload_modal');
            $('#load-object').modal();
        });
    })();

    // Configure the assembly modal
    (function() {
        var $modal = $('#assemble-modal');

        var $inputContainer = $('#assembly-input-container');
        var $textarea = $('#assembly-input');
        var $releaseMessage = $('#release-message');
        var $btnAssemble = $('#btn-assemble');
        var $btnLoad = $('#btn-assembly-load');
        var $btnDownloadObject = $('#btn-download-object');
        var $btnDownloadSymbol = $('#btn-download-symbol');

        var $errorNoun = $('#assembly-error-noun');
        var $errorList = $('#assembly-errors');

        var $successAlert = $modal.find('.alert-success');
        var $errorAlert = $modal.find('.alert-danger');

        var assemblyResult = null;
        $btnAssemble.click(function() {
            var code = $textarea.val();
            assemblyResult = assemble(code);
            $errorList.empty();
            if (assemblyResult.error) {
                var errorList = assemblyResult.error;
                for (var i = 0; i < errorList.length; i++) {
                    $('<li>').text(errorList[i]).appendTo($errorList);
                }
                $errorNoun.text(errorList.length === 1 ? 'an error' : 'some errors');
                $errorAlert.slideDown();
                $successAlert.slideUp();
            } else {
                $successAlert.slideDown();
                $errorAlert.slideUp();
            }
        });
        $btnLoad.click(function() {
            lc3.loadAssembled(assemblyResult);
            $modal.modal('hide');
        });
        $btnDownloadObject.click(function() {
            if (assemblyResult === null) {
                return;
            }
            var orig = assemblyResult.orig;
            var mc = assemblyResult.machineCode;
            var bytes = wordsToBytes([orig].concat(mc));
            doDownload(bytes);
        });
        $btnDownloadSymbol.click(function() {
            if (assemblyResult === null) {
                return;
            }
            var pre = '// ';
            var lines = [];
            var symbols = assemblyResult.symbolTable;
            lines.push(pre + 'Symbol table');
            lines.push(pre + 'Symbol Name       Page Address');
            lines.push(pre + '----------------  ------------');
            // Convert to 2D list (list of tuples)
            var tuples = [];
            for (var symbol in symbols) {
                tuples.push([symbol, symbols[symbol]]);
            }
            tuples.sort(function(a, b) { return a[1] - b[1]; });
            for (var i = 0; i < tuples.length; i++) {
                var label = tuples[i][0];
                var address = tuples[i][1];
                var formattedName = label + Array(17 - label.length).join(' ');
                var formattedAddress = LC3Util.toHexString(address).substring(1);
                lines.push(pre + formattedName + '  ' + formattedAddress);
            }
            lines.push(''); // to get an end-of-file line terminator
            doDownload(stringToBytes(lines.join('\n')));
        });

        $inputContainer.bind({
            dragover: function() {
                $releaseMessage.slideDown();
                return false;
            },
            dragend: function() {
                $releaseMessage.slideUp();
                return false;
            },
            dragleave: function() {
                $releaseMessage.slideUp();
                return false;
            },
            drop: function(e) {
                e = e || window.event;
                e = e.originalEvent || e;
                e.preventDefault();
                $releaseMessage.slideUp();

                var files = (e.files || e.dataTransfer.files);
                if (!files) {
                    return;
                }
                var file = files[0];
                if (!file) {
                    return;
                }
                var reader = new FileReader();
                reader.onload = function(e) {
                    var dataString = e.target.result;
                    $textarea.val(dataString);
                };
                reader.readAsText(file);
            }
        });

        $('#mem-assemble').click(function() {
            sendEvent('assemble', 'open_assemble_modal');
            $modal.modal();
        });
        $modal.bind('show.bs.modal', function() {
            $errorAlert.hide();
            $successAlert.hide();
            $releaseMessage.hide();
            assemblyResult = null;
        });
    })();

    // Configure the raw code modal
    (function() {
        var $modal = $('#raw-modal');

        var $inputContainer = $('#raw-input-container');
        var $textarea = $('#raw-input');
        var $releaseMessage = $('#raw-release-message');
        var $btnProcess = $('#btn-process-raw');
        var $btnLoad = $('#btn-raw-load');
        var $btnDownloadObject = $('#btn-download-raw-object');

        var $errorNoun = $('#raw-error-noun');
        var $errorTag = $('#raw-error');

        var $successAlert = $modal.find('.alert-success');
        var $errorAlert = $modal.find('.alert-danger');

        var assemblyResult = null;
        $btnProcess.click(function() {
            var code = $textarea.val();
            assemblyResult = hexbin(code);
            if (assemblyResult.error) {
                $errorTag.text(assemblyResult.error);
                $errorAlert.slideDown();
                $successAlert.slideUp();
            } else {
                $successAlert.slideDown();
                $errorAlert.slideUp();
            }
        });
        $btnLoad.click(function() {
            lc3.loadAssembled(assemblyResult);
            $modal.modal('hide');
        });
        $btnDownloadObject.click(function() {
            if (assemblyResult === null) {
                return;
            }
            var orig = assemblyResult.orig;
            var mc = assemblyResult.machineCode;
            var bytes = wordsToBytes([orig].concat(mc));
            doDownload(bytes);
        });

        $inputContainer.bind({
            dragover: function() {
                $releaseMessage.slideDown();
                return false;
            },
            dragend: function() {
                $releaseMessage.slideUp();
                return false;
            },
            dragleave: function() {
                $releaseMessage.slideUp();
                return false;
            },
            drop: function(e) {
                e = e || window.event;
                e = e.originalEvent || e;
                e.preventDefault();
                $releaseMessage.slideUp();

                var files = (e.files || e.dataTransfer.files);
                if (!files) {
                    return;
                }
                var file = files[0];
                if (!file) {
                    return;
                }
                var reader = new FileReader();
                reader.onload = function(e) {
                    var dataString = e.target.result;
                    $textarea.val(dataString);
                };
                reader.readAsText(file);
            }
        });

        $('#mem-raw').click(function() {
            sendEvent('raw', 'open_raw_modal');
            $modal.modal();
        });
        $modal.bind('show.bs.modal', function() {
            $errorAlert.hide();
            $successAlert.hide();
            $releaseMessage.hide();
            assemblyResult = null;
        });
    })();

    // Activate!
    $('#container-wait').slideUp();
    $('#container-main').fadeIn();
});
