import Foundation
import RealityKit

@main
struct ReconstructVideoUSDZ {
    static func main() async throws {
        let arguments = CommandLine.arguments
        guard arguments.count >= 3 else {
            FileHandle.standardError.write(Data("Usage: reconstruct-video-usdz <frames-directory> <output.usdz> [preview|reduced|medium|full|raw]\n".utf8))
            exit(64)
        }

        let inputURL = URL(fileURLWithPath: arguments[1], isDirectory: true)
        let outputURL = URL(fileURLWithPath: arguments[2])
        let detailName = arguments.count >= 4 ? arguments[3].lowercased() : "medium"
        let detail: PhotogrammetrySession.Request.Detail = switch detailName {
        case "preview": .preview
        case "reduced": .reduced
        case "full": .full
        case "raw": .raw
        default: .medium
        }

        var configuration = PhotogrammetrySession.Configuration()
        configuration.sampleOrdering = .sequential
        configuration.featureSensitivity = .high

        let session = try PhotogrammetrySession(input: inputURL, configuration: configuration)
        let request = PhotogrammetrySession.Request.modelFile(url: outputURL, detail: detail)
        try session.process(requests: [request])

        var lastPercent = -1
        for try await output in session.outputs {
            switch output {
            case .requestProgress(_, let fractionComplete):
                let percent = Int((fractionComplete * 100).rounded())
                if percent != lastPercent {
                    print("progress=\(percent)%")
                    lastPercent = percent
                }
            case .requestProgressInfo:
                break
            case .requestComplete(_, let result):
                print("result=\(result)")
            case .requestError(_, let error):
                throw error
            case .processingComplete:
                print("status=complete")
                return
            case .inputComplete:
                print("status=input-complete")
            case .invalidSample(let id, let reason):
                print("invalid-sample=\(id) reason=\(reason)")
            case .skippedSample(let id):
                print("skipped-sample=\(id)")
            case .automaticDownsampling:
                print("status=automatic-downsampling")
            case .stitchingIncomplete:
                print("status=stitching-incomplete")
            case .processingCancelled:
                throw CancellationError()
            @unknown default:
                print("status=unknown-output")
            }
        }
    }
}
