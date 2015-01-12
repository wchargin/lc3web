$(document).ready(function() {
    var memoryRows = Array(16);
    var memory = Array(65536);
    var pc = 0x3000;
    var breakpoints = [0x3006];

    var getMemory = function(address) {
        var data = memory[address];
        return data === undefined ? 0 : data;
    };
    memory[0x3000] = 0x1401;

    var toHexString = function(value) {
        var hex = value.toString(16).toUpperCase();
        var padLength = 4;
        if (hex.length < padLength) {
            hex = (Array(padLength - hex.length + 1).join('0')) + hex;
        }
        return 'x' + hex;
    };

    var parseNumber = function(value) {
        if (value.length == 0) {
            return NaN;
        }
        if (value[0] == 'x') {
            return parseInt(value.slice(1), 16);
        } else {
            return parseInt(value);
        }
    };

    var updateHexValueTooltip = function(element) {
        var hex = $(element).text().replace(/[^0-9A-Fa-f]/g, '');
        var num = parseInt("0x" + hex);
        var titleText = "decimal " + num;
        $(element).attr("title", titleText);
        $(element).tooltip('fixTitle');
    };

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
        $row.append(createCell(['memory-hex', 'hex-value'], 'x0000'));
        $row.append(createCell(['memory-instruction'], 'NOP'));
        $cellTableBody.append($row);
    }

    var updateMemory = function(startPosition) {
        for (var i = 0; i < memoryRows.length; i++) {
            var address = i + startPosition;
            var data = getMemory(address);
            var $row = $('.memory-cell[data-cell-number="' + i + '"]');
            $row.find('span.memory-address').text(toHexString(address));
            $row.find('span.memory-label').text("TODO");
            $row.find('span.memory-hex').text(toHexString(data));
            $row.find('span.memory-instruction').text("TODO");
            if (pc === address) {
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

    $(".hex-value").each(function() {
        var $el = $(this);
        updateHexValueTooltip($el);
    });

    $('#memory-jumpto').on('input', function() {
        var text = $(this).val();
        var address = parseNumber(text);
        if (!isNaN(address)) {
            updateMemory(address);
        }
    });
});
