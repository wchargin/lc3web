$(document).ready(function() {
    var updateHexValueTooltip = function(element) {
        var hex = $(element).text().replace(/[^0-9A-Fa-f]/g, '');
        var hexString = "0x" + hex;
        var num = parseInt(hexString);
        var titleText = "decimal " + num;
        $(element).attr("title", titleText);
        $(element).tooltip('fixTitle');
    };
    $(".hex-value").each(function() {
        var $el = $(this);
        updateHexValueTooltip($el);
    });
});
