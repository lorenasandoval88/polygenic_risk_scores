import {get23,filterUrls} from "./get23me.js"
import { getPGSTxtsHm, getPGSIds} from "./getPgs.js"
import {Match2 } from "./prs.js"

//-------------------------------------------------------------------------
// 23andme data
let users = await filterUrls()
let userUrls = (users.slice(7,9)).map(x => x["genotype.download_url"])
console.log("userUrls",userUrls)

//---------------------------------------------------------------
// pgs catalog data
let varMin = 5
let varMax = 7
let results = await getPGSIds("traitCategories", "Cancer",  varMin, varMax)
let PGStextsHm = await getPGSTxtsHm(results.map(x=>x.id))
console.log("results",results)
console.log("PGStextsHm",PGStextsHm)

let PGS = PGStextsHm.slice(2,4)
let my23Txts = await get23(userUrls)
console.log("my23Txts",my23Txts)

// //----------------------------------------------------------------------
// // testing one trait, "type 2 diabetes mellitus"

function PRS_fun(matrix){
    let PRS =[]
    for (let i=0; i<matrix.my23.length; i++){
        console.log("---------------------------")
        console.log("processing user #...",i)

        for(let j=0; j<matrix.PGS.length; j++){
            let input = { "pgs":matrix.PGS[j], "my23":matrix.my23[i]}
            let res = Match2(input)
                PRS.push(res)
                console.log("processing PGS model: ",matrix.PGS[j].id)
        }
    }

    return PRS
}
// data object defined here ----------------------------
let data = {}

data["PGS"] = PGS
data["my23"] = my23Txts
let PRS = PRS_fun(data)
data["PRS"] = PRS

console.log("data",data )

// export{PRS_fun}