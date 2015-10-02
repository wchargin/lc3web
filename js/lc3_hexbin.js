var hexbin = (function() {

    /*
     * Remove comments, preserving empty lines (for error reporting, etc.).
     */
    var removeComments = function(text) {
        return (text || "").split("\n").map(function(line) {
            // Split on the comment character, and just take the first part
            // (i.e., everything before the comment starts).
            return line.split(";")[0];
        }).join("\n");
    };

    /*
     * Guess whether this is binary or hex, or fail if neither matches.
     * Returns either { error: <error message string> }
     * or { type: "hex" | "binary" }.
     */
    var guessInputType = function(input) {
        // Make sure the input doesn't have invalid characters.
        var lines = input.split("\n");
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i];
            var match = line.match(/[^\s0-9A-Fa-f]/);
            if (!match) {
                continue;
            }

            var badCharacter = match[0];
            var message = "Invalid character '" + badCharacter + "' " +
                "at line " + (i + 1);
            return {
                error: message,
            };
        }

        var justData = input.replace(/\s/g, "");
        var isHex = !!justData.match(/[^01]/);

        var shouldDivide = isHex ? 4 : 16;
        if (justData.length % shouldDivide !== 0) {
            var characterNoun = justData.length === 1 ?
                "character" : "characters";
            var dataType = isHex ? "hexadecimal" : "binary";
            var message = "Found a total of " +
                justData.length + " " + characterNoun + ", " +
                "but expected to find a multiple of " + shouldDivide + " " +
                "for " + dataType + " data.";
            return {
                error: message,
            };
        }

        return {
            type: isHex ? "hex" : "binary",
        };
    };

    var extractData = function(lines, inputType) {
        var justData = lines.replace(/\s/g, "");

        var charsPerWord = inputType === "hex" ? 4 : 16;
        var words = new Array(justData.length / charsPerWord);
        if (words.length === 0) {
            var message = "Your raw data is empty! " +
                "You need to at least have an origin (.ORIG) address.";
            return {
                error: message,
            };
        }

        for (var i = 0; i < words.length; i++) {
            var start = charsPerWord * i;
            words[i] = justData.substr(start, charsPerWord);
        }

        var base = inputType === "hex" ? 16 : 2;
        var machineCode = words.map(function(word) {
            return parseInt(word, base);
        });

        return {
            orig: machineCode[0],
            machineCode: machineCode.slice(1),
        };
    };

    return function(fileContents) {
        var contents = removeComments(fileContents);

        var maybeInputType = guessInputType(contents);
        if (maybeInputType.error) {
            return maybeInputType;
        }
        var inputType = maybeInputType.type;

        return extractData(contents, inputType);
    };
})();
