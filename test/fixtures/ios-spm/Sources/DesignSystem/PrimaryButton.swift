import SwiftUI

/// The main call to action.
public struct PrimaryButton: View {
    let title: String

    public init(_ title: String) {
        self.title = title
    }

    public var body: some View {
        Text(title)
            .padding(12)
            .background(Color("Brand/Primary", bundle: .module))
            // A colour written into the code, which the count finds.
            .foregroundStyle(Color(red: 0.98, green: 0.98, blue: 1.0))
            // Neither this comment's Color(red: 1, green: 0, blue: 0) nor the string below is counted.
            .accessibilityHint("Color(red: 0.5, green: 0.5, blue: 0.5)")
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color(UIColor(white: 0.2, alpha: 1)), lineWidth: 1))
    }
}

#Preview {
    PrimaryButton("Save")
}
