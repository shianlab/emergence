@{
    IncludeRules = @(
        'PSAvoidTrailingWhitespace'
        'PSAvoidUsingInvokeExpression'
        'PSAvoidUsingPlainTextForPassword'
        'PSAvoidUsingConvertToSecureStringWithPlainText'
        'PSAvoidUsingUsernameAndPasswordParams'
        'PSAvoidUsingEmptyCatchBlock'
        'PSUseDeclaredVarsMoreThanAssignments'
        'PSUseCorrectCasing'
        'PSUseConsistentIndentation'
        'PSUseConsistentWhitespace'
        'PSPlaceOpenBrace'
        'PSPlaceCloseBrace'
    )
    Rules = @{
        PSUseConsistentIndentation = @{ Enable = $true; Kind = 'space'; IndentationSize = 4 }
        PSUseConsistentWhitespace = @{
            Enable = $true
            CheckOpenBrace = $true
            CheckOpenParen = $true
            CheckOperator = $true
            CheckSeparator = $true
            CheckInnerBrace = $true
            CheckPipe = $true
        }
        PSPlaceOpenBrace = @{ Enable = $true; OnSameLine = $true; NewLineAfter = $true; IgnoreOneLineBlock = $false }
        PSPlaceCloseBrace = @{ Enable = $true; NewLineAfter = $true; IgnoreOneLineBlock = $false; NoEmptyLineBefore = $true }
    }
}
