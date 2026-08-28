# The app is a courier: two activities, a URI list, and a WebView. There is
# nothing here reflection reaches that R8 cannot see, and no @JavascriptInterface
# to keep — the page talks to native code through addWebMessageListener, which is
# an ordinary Kotlin lambda.
#
# Line numbers, though, are worth the ~10KB: a stack trace from a device is the
# only diagnostic this app will ever get.
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile
