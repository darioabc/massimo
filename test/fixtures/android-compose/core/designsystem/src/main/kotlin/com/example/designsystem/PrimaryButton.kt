package com.example.designsystem

import androidx.compose.material3.Button
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.tooling.preview.Preview

/** The main call to action. */
@Composable
fun PrimaryButton(title: String, onClick: () -> Unit) {
    // A colour written into the code, which the count finds; Color(0xFF000000) in this comment is not.
    val border = Color(0xFF112233)
    Button(onClick = onClick) { Text(title, color = border) }
}

@Preview
@Composable
private fun PrimaryButtonPreview() {
    PrimaryButton("Save") {}
}
